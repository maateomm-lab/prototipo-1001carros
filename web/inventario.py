"""Motor de inventario y precio dinámico (funciones puras, sin servidor ni base de datos).

Principio: el precio NO sube porque se acumuló costo (costo hundido). El costo acumulado define el PISO de
equilibrio; el precio sugerido lo definen el MERCADO (modelo XGBoost) y los DÍAS EN PISO. Solo se sugiere SUBIR
cuando el precio publicado está por debajo del rango de mercado.

Una unidad es un dict con: marca, familia, version, modelo, anio, km, fecha_ingreso, costo_compra,
reacondicionamiento, precio_publicado, ultima_revision (y los campos del auto que usa el modelo).
"""
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

DIAS_CURVA = 210            # largo mínimo de la curva de mercado (una sola predicción en lote)
CAMPOS_MODELO = ["subtipo", "transmision", "combustible", "traccion", "ciudad", "provincia_placa", "vendedor_tipo",
                 "climatizacion", "tapizado", "direccion", "vidrios"]

COMPONENTES = ["capital", "seguro", "espacio", "lavado"]
PARAM_DE = dict(capital="tasa_capital_anual", seguro="tasa_seguro_anual", espacio="costo_espacio_diario",
                lavado="costo_lavado_diario")      # parámetro que alimenta a cada componente del costo diario
COSTOS_INFO = dict(
    capital=dict(nombre="Capital", unidad="% anual",
                 nota="Lo que cuesta tener plata inmovilizada en el carro: tasa × (costo de compra + reacondicionamiento) ÷ 365. "
                      "Dato de la empresa (ejemplo de costo de inventario de 1001Carros)."),
    seguro=dict(nombre="Seguro", unidad="% anual",
                nota="Seguro del vehículo mientras está en el patio: tasa × (costo de compra + reacondicionamiento) ÷ 365."),
    espacio=dict(nombre="Espacio en patio", unidad="USD por día",
                 nota="Lo que cuesta ocupar un lugar en el patio (arriendo, vigilancia, servicios), igual para todos los carros."),
    lavado=dict(nombre="Lavado y mantenimiento", unidad="USD por día",
                nota="Lavado, cargas de batería y mantenimiento básico para que el carro se mantenga presentable."),
)

PARAMS_DEF = dict(
    tasa_capital_anual=0.12,        # costo del capital inmovilizado (dato de la empresa)
    tasa_seguro_anual=0.02,         # seguro (supuesto)
    costo_espacio_diario=2.0,       # USD por día de patio (supuesto)
    costo_lavado_diario=1.0,        # USD por día de lavado y mantenimiento (supuesto)
    fuentes=dict(tasa_capital_anual="empresa", tasa_seguro_anual="supuesto", costo_espacio_diario="supuesto",
                 costo_lavado_diario="supuesto"),     # de dónde sale cada valor: "empresa" o "supuesto"
    piso_margen=0.08,               # margen mínimo sobre el costo acumulado (hasta el día tramos[2])
    dias_revision=7,                # cada cuántos días se debe revisar el precio
    tramos=[30, 60, 90, 120],       # límites de los tramos: 0–30 / 31–60 / 61–90 / 91–120 / >120
    ajustes=[0.0, 0.0, -0.03, -0.06, -0.08],   # ajuste vs mercado por tramo (el 1.º usa la regla de la banda)
    tolerancia_banda=0.03,          # holgura alrededor de [bajo50, alto50]
    tolerancia_excepcion=0.03,      # si el precio aplicado se aleja más del sugerido hay que justificarlo
    # objetivos del caso (Tablero de objetivos)
    base_dias_promedio=75, meta_dias_promedio=65,        # días promedio en piso
    base_pct_mas_120=0.178, meta_pct_mas_120=0.09,       # % de unidades en piso con más de 120 días
    meta_pct_en_regla=1.0,                               # % de cambios de precio dentro de la regla
    meta_beneficio_anual=367080.0,                       # USD al año (margen + costo de capital evitado)
)
VENTANA_OBJETIVOS = 90      # días hacia atrás que miran los objetivos


# ----------------------------------------------------------------------------- utilidades
def usd(v):
    """Formato Ecuador: USD 18.950"""
    return "USD " + f"{round(v):,}".replace(",", ".")


def usd2(v):
    """Con centavos y coma decimal: USD 25,15"""
    return "USD " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def pct_txt(v):
    """0.12 -> '12 %', 0.025 -> '2,5 %'"""
    return f"{v * 100:g}".replace(".", ",") + " %"


def _fecha(f):
    if isinstance(f, datetime):
        return f.date()
    if isinstance(f, date):
        return f
    return date.fromisoformat(str(f)[:10])


def validar_parametros(q):
    """Devuelve los parámetros completos (valores por defecto + lo que llegó) o ValueError."""
    # Parámetros guardados con la versión anterior: costo_capital_diario y costo_operativo_diario ya no existen
    # (se ignoran) y una tasa de capital vacía vuelve al valor por defecto; el costo ahora se calcula por unidad.
    q = {k: v for k, v in (q or {}).items() if k in PARAMS_DEF and not (k == "tasa_capital_anual" and v in (None, ""))}
    p = {**PARAMS_DEF, **q}
    try:
        for k in ["tasa_capital_anual", "tasa_seguro_anual", "costo_espacio_diario", "costo_lavado_diario", "piso_margen",
                  "tolerancia_banda", "tolerancia_excepcion", "base_dias_promedio", "meta_dias_promedio",
                  "base_pct_mas_120", "meta_pct_mas_120", "meta_pct_en_regla", "meta_beneficio_anual"]:
            p[k] = float(p[k])
            if p[k] < 0:
                raise ValueError
        for k in ["tasa_capital_anual", "tasa_seguro_anual", "base_pct_mas_120", "meta_pct_mas_120", "meta_pct_en_regla"]:
            if p[k] > 1:
                raise ValueError(f"{k.replace('_', ' ').capitalize()} debe ir como porcentaje entre 0 y 100")
        f = {**PARAMS_DEF["fuentes"], **(p.get("fuentes") or {})}
        p["fuentes"] = {k: (f[k] if f[k] in ("empresa", "supuesto") else "supuesto") for k in PARAMS_DEF["fuentes"]}
        p["dias_revision"] = int(p["dias_revision"])
        p["tramos"] = [int(x) for x in p["tramos"]]
        p["ajustes"] = [float(x) for x in p["ajustes"]]
    except (TypeError, ValueError) as e:
        raise ValueError(str(e) if str(e).endswith("100") else "Los parámetros deben ser números válidos (no negativos)")
    if len(p["tramos"]) != 4 or p["tramos"] != sorted(set(p["tramos"])) or p["tramos"][0] < 1:
        raise ValueError("Los límites de tramo deben ser 4 días distintos y crecientes")
    if len(p["ajustes"]) != 5 or any(a > 0.5 or a < -0.9 for a in p["ajustes"]):
        raise ValueError("Los ajustes por tramo deben ser 5 porcentajes razonables")
    if p["dias_revision"] < 1:
        raise ValueError("Los días de revisión deben ser al menos 1")
    return p


def tramo(d, p):
    """0 = 0–30 días, 1 = 31–60, 2 = 61–90, 3 = 91–120, 4 = más de 120."""
    for i, lim in enumerate(p["tramos"]):
        if d <= lim:
            return i
    return len(p["tramos"])


def nombres_tramos(p):
    t = p["tramos"]
    return [f"0–{t[0]}", f"{t[0] + 1}–{t[1]}", f"{t[1] + 1}–{t[2]}", f"{t[2] + 1}–{t[3]}", f">{t[3]}"]


def dias_en_piso(u, hoy=None):
    fin = _fecha(u["fecha_venta"]) if u.get("fecha_venta") else _fecha(hoy or date.today())
    return max((fin - _fecha(u["fecha_ingreso"])).days, 0)


# ----------------------------------------------------------------------------- costos
def _base_costo(u):
    return (u.get("costo_compra") or 0) + (u.get("reacondicionamiento") or 0)


def _componentes_auto(u, p):
    """Costo diario de cada componente según los parámetros: depende del valor de cada carro."""
    base = _base_costo(u)
    return dict(capital=base * p["tasa_capital_anual"] / 365, seguro=base * p["tasa_seguro_anual"] / 365,
                espacio=p["costo_espacio_diario"], lavado=p["costo_lavado_diario"])


def costo_diario(u, p):
    """USD por día de la unidad: capital + seguro (proporcionales a lo invertido) + espacio + lavado.
    La unidad puede traer su propio total (costo_diario_manual) o sobrescribir un componente (costo_<x>_manual)."""
    if u.get("costo_diario_manual") is not None:
        return float(u["costo_diario_manual"])
    auto = _componentes_auto(u, p)
    return sum(u[f"costo_{k}_manual"] if u.get(f"costo_{k}_manual") is not None else auto[k] for k in COMPONENTES)


def costo_acumulado(u, d, p):
    """costo_compra + reacondicionamiento + d × costo diario de la unidad."""
    return _base_costo(u) + d * costo_diario(u, p)


def desglose_costo(u, p, dias=0):
    """Desglose del costo diario de una unidad con la fórmula en texto (para mostrarlo en pantalla)."""
    base, auto = _base_costo(u), _componentes_auto(u, p)
    de_que = usd(base) + (" (compra + reacond.)" if u.get("reacondicionamiento") else "")
    filas = []
    for k in COMPONENTES:
        manual = u.get(f"costo_{k}_manual")
        par = PARAM_DE[k]
        if k in ("capital", "seguro"):
            formula = f"{pct_txt(p[par])} × {de_que} ÷ 365 = {usd2(auto[k])}/día"
        else:
            formula = f"{usd2(auto[k])}/día fijo por carro"
        if manual is not None:
            formula = f"Valor propio de esta unidad: {usd2(manual)}/día (por parámetros sería {usd2(auto[k])})"
        filas.append(dict(clave=k, nombre=COSTOS_INFO[k]["nombre"], valor=float(manual) if manual is not None else auto[k],
                          manual=manual is not None, formula=formula,
                          fuente="manual" if manual is not None else p["fuentes"][par], nota=COSTOS_INFO[k]["nota"]))
    total = costo_diario(u, p)
    total_manual = u.get("costo_diario_manual") is not None
    return dict(base=base, componentes=filas, total_diario=total, total_manual=total_manual,
                suma_componentes=sum(f["valor"] for f in filas), dias=dias, acumulado=_base_costo(u) + dias * total,
                formula_acumulado=f"{usd(base)} + {dias} días × {usd2(total)} = {usd(base + dias * total)}")


# ----------------------------------------------------------------------------- mercado en el tiempo
def curva_mercado(art, u, hasta=DIAS_CURVA):
    """Valor de mercado (y rango probable) de la unidad para cada día d = 0..hasta desde su ingreso.
    La edad del auto avanza con la fecha (edad fraccionaria) y el km queda fijo (el carro está parado).
    Una sola predicción para toda la curva; luego se suaviza para que nunca suba con el tiempo."""
    import numpy as np
    import pandas as pd
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "xgboost"))
    import pricing_ml as P

    base = (_fecha(u["fecha_ingreso"]) - date(int(u["anio"]), 1, 1)).days
    dias = np.arange(hasta + 1)
    edad = np.clip((base + dias) / 365, 0, None)
    km, pn = u.get("km"), u.get("pn_con_iva")
    df = pd.DataFrame(dict(marca=u["marca"], familia=u["familia"], version=u.get("version"), modelo=u.get("modelo"),
                           **{c: u.get(c) for c in CAMPOS_MODELO}, edad=edad,
                           km=km if km is not None else np.nan,
                           km_anio=(km / np.maximum(edad, 1)) if km is not None else np.nan,
                           cilindraje=u.get("cilindraje") or np.nan,
                           pn_sin_iva=(pn / P.IVA) if pn else np.nan))
    X = P.matriz(df, art["cats"])
    mu = art["modelo"].predict(X)
    q50 = art["q50"] * P.sigma(art["dificultad"], X)
    c = pd.DataFrame(dict(d=dias, mercado=np.exp(mu), bajo50=np.exp(mu - q50), alto50=np.exp(mu + q50)))
    c = P._suavizar_decreciente(c, "d", ["mercado", "bajo50", "alto50"])
    return escalar_curva(c.to_dict("records"), u.get("mercado_manual"))


def escalar_curva(curva, mercado_manual):
    """Aplica la referencia manual de mercado. El modelo aporta cuánto se deprecia por día y el asesor aporta el
    nivel: mercado_manual × (mercado_modelo(d) / mercado_modelo(0)); la banda se escala con el mismo factor.
    Cada fila conserva el valor del modelo (modelo, modelo_bajo50, modelo_alto50) para compararlo en pantalla."""
    k = (float(mercado_manual) / curva[0]["mercado"]) if mercado_manual else 1.0
    return [{**c, "modelo": c["mercado"], "modelo_bajo50": c["bajo50"], "modelo_alto50": c["alto50"],
             "mercado": c["mercado"] * k, "bajo50": c["bajo50"] * k, "alto50": c["alto50"] * k} for c in curva]


def explicar_confianza(nivel, ancho, n, fuera, tiene_pn, manual, limite, n_anio=None, anio=None):
    """Texto que explica por qué el valor de mercado tiene esa confianza (misma lógica que el cotizador).
    n = avisos de la familia (lo que mide el nivel); n_anio = avisos de esa familia del mismo año (solo informa)."""
    motivos = []
    if n < 10:
        motivos.append(f"solo {n} aviso{'' if n == 1 else 's'} de esta familia")
    elif n < 30 and nivel != "alta":
        motivos.append(f"pocos avisos de esta familia ({n})")
    if nivel != "alta" and n_anio is not None and n_anio < 10 and n >= 10:
        motivos.append(f"solo {n_anio} aviso{'' if n_anio == 1 else 's'} del {anio}")
    if not tiene_pn:
        motivos.append("sin precio de nuevo")
    if fuera:
        motivos.append(f"el valor supera {usd(limite)}, donde hay pocos avisos y el error sube")
    if ancho > 12:
        motivos.append(f"el rango probable es amplio (±{ancho:.0f} %)")
    if nivel == "alta":
        texto = "Confianza alta: hay avisos suficientes y el rango probable es angosto."
    else:
        texto = f"Confianza {nivel}: " + (" y ".join([", ".join(motivos[:-1]), motivos[-1]]) if len(motivos) > 1
                                           else (motivos[0] if motivos else "el rango probable es amplio")) + "."
        if manual:
            texto += " Hay una referencia manual: el nivel del precio lo fija esa referencia."
        elif nivel == "baja":
            texto += " Revise los comparables y fije una referencia manual."
    return dict(motivos=motivos, texto=texto)


# ----------------------------------------------------------------------------- precio sugerido
def _sugerido_base(d, c, costo, p, pub=None):
    """Precio sugerido del día d. Sin precio publicado (pub=None) es la curva de referencia por tramo.
    Con precio publicado aplica la regla de 'mantener / subir' del primer tramo y de la banda."""
    t, tol = tramo(d, p), p["tolerancia_banda"]
    m, lo, hi = c["mercado"], c["bajo50"], c["alto50"]
    if t == 0:
        if pub is None or pub < lo * (1 - tol):
            s = m
        elif pub > hi * (1 + tol):
            s = hi
        else:
            s = pub                                     # dentro de la banda: mantener
    else:
        s = m * (1 + p["ajustes"][t])
    if d <= p["tramos"][2]:
        piso = costo * (1 + p["piso_margen"])           # hasta 90 días: costo + margen
    elif d <= p["tramos"][3]:
        piso = costo                                    # de 91 a 120: equilibrio
    else:
        piso = None                                     # más de 120: se permite liquidar bajo costo
    return (max(s, piso) if piso is not None else s), piso


def serie(u, curva, p, hasta=None):
    """Una fila por día para el gráfico: costo acumulado, mercado, banda y sugerido de referencia."""
    filas = []
    for c in curva[: (hasta + 1) if hasta else None]:
        d = c["d"]
        costo = costo_acumulado(u, d, p)
        s, _ = _sugerido_base(d, c, costo, p)
        filas.append(dict(d=d, costo=costo, mercado=c["mercado"], bajo50=c["bajo50"], alto50=c["alto50"], sugerido=s,
                          modelo=c.get("modelo")))
    return filas


def dia_equilibrio(u, curva, p):
    """Primer día en que el valor de mercado ya no cubre el costo acumulado (None si no ocurre en la curva)."""
    for c in curva:
        if c["mercado"] <= costo_acumulado(u, c["d"], p):
            return c["d"]
    return None


def evaluar(u, curva, p, hoy=None, n_comparables=None, conf=None):
    """Todos los cálculos de una unidad para el día de hoy.
    conf: confianza del valor de mercado ({'nivel', 'texto', ...}); con confianza baja y sin referencia manual el
    semáforo no puede ser verde y la recomendación lleva el aviso."""
    hoy = _fecha(hoy or date.today())
    d = dias_en_piso(u, hoy)
    c = curva[min(d, len(curva) - 1)]
    pub = u["precio_publicado"]
    tol, t = p["tolerancia_banda"], tramo(d, p)
    costo = costo_acumulado(u, d, p)
    m, lo, hi = c["mercado"], c["bajo50"], c["alto50"]

    # Subir solo si está bajo el rango de mercado Y bajo el objetivo de su tramo: un precio de liquidación (-8 %)
    # queda bajo la banda a propósito y no debe provocar una recomendación de subir.
    base = min(lo, m * (1 + p["ajustes"][t])) if t > 0 else lo
    subir = pub < base * (1 - tol)
    s, piso = _sugerido_base(d, c, costo, p, pub)
    if subir:
        s = max(s, base) if piso is None else max(s, base, piso)
    else:
        s = min(s, pub)                                 # no se sube el precio si ya está dentro del mercado
    dentro = lo * (1 - tol) <= pub <= hi * (1 + tol)
    ult = _fecha(u.get("ultima_revision") or u["fecha_ingreso"])
    vencida = (hoy - ult).days > p["dias_revision"]

    de = dia_equilibrio(u, curva, p)
    util_pub, util_sug = pub - costo, s - costo
    d30 = min(d + 30, len(curva) - 1)
    s30, _ = _sugerido_base(d30, curva[d30], costo_acumulado(u, d30, p), p)
    util_espera = min(s30, s) - costo_acumulado(u, d30, p)
    perdida_espera = util_sug - util_espera             # lo que se pierde (o gana) por esperar 30 días más

    dif = pub / s - 1
    if subir:
        rec = "Subir"
        texto = (f"Está {abs(pub / lo - 1) * 100:.0f} % bajo el rango de mercado ({usd(lo)} – {usd(hi)}); "
                 f"subir a {usd(s)}.")
    elif dif > tol:
        rec = "Liquidar" if t == len(p["tramos"]) else "Bajar"
        sobre = f"está {(pub / m - 1) * 100:.0f} % sobre el mercado" if pub > m * (1 + tol) \
            else f"el tramo {nombres_tramos(p)[t]} días pide {p['ajustes'][t] * 100:.0f} % vs mercado"
        texto = f"Lleva {d} días y {sobre}; bajar a {usd(s)}."
        if rec == "Liquidar":
            texto = f"Lleva {d} días (más de {p['tramos'][3]}); liquidar a {usd(s)}. " + \
                (f"Pérdida de {usd(-util_sug)} sobre el costo acumulado; " if util_sug < 0 else
                 f"Utilidad de {usd(util_sug)}; ") + \
                f"esperar 30 días más {'costaría ' + usd(perdida_espera) + ' adicionales' if perdida_espera > 0 else 'no mejora el resultado'}."
    else:
        rec = "Mantener"
        if pub < costo:
            texto = f"El precio publicado ya está bajo el costo acumulado ({usd(costo)}); no bajar más y cerrar la venta."
        elif t == 0 and dentro:
            texto = f"Lleva {d} días y está dentro del rango de mercado; mantener {usd(pub)}."
        else:
            texto = f"Lleva {d} días y el precio está alineado con el mercado; mantener {usd(pub)}" + \
                (f" (el sugerido es {usd(s)}, dentro de ±{tol * 100:.0f} %)." if abs(pub - s) >= 1 else ".")

    if pub < costo or d > p["tramos"][2]:
        sem = "rojo"
    elif d <= p["tramos"][1] and dentro and not vencida:
        sem = "verde"
    else:
        sem = "amarillo"

    manual = u.get("mercado_manual") is not None
    aviso = None
    if conf and conf["nivel"] == "baja" and not manual:
        aviso = conf["texto"]
        texto += " Ojo: confianza baja en el valor de mercado."
        if sem == "verde":
            sem = "amarillo"

    return dict(
        dias=d, tramo=t, tramo_nombre=nombres_tramos(p)[t], costo_diario=costo_diario(u, p), costo_acumulado=costo,
        mercado=m, bajo50=lo, alto50=hi, pct_vs_mercado=pub / m - 1, sugerido=s, piso=piso,
        mercado_modelo=c.get("modelo", m), referencia_manual=manual, confianza=conf, aviso_confianza=aviso,
        recomendacion=rec, texto=texto, dentro_banda=dentro, revision_vencida=vencida,
        dia_equilibrio=de,
        fecha_equilibrio=(_fecha(u["fecha_ingreso"]) + timedelta(days=de)).isoformat() if de is not None else None,
        dias_hasta_equilibrio=(de - d) if de is not None else None,
        utilidad_publicado=util_pub, utilidad_sugerido=util_sug, utilidad_espera_30=util_espera,
        semaforo=sem, n_comparables=n_comparables)


def utilidad_real(u, p):
    """Utilidad de una unidad ya vendida: precio de venta menos el costo acumulado hasta la fecha de venta."""
    d = dias_en_piso(u)
    return dict(dias=d, costo_acumulado=costo_acumulado(u, d, p), utilidad=u["precio_venta"] - costo_acumulado(u, d, p))


# ----------------------------------------------------------------------------- tablero de objetivos
def indicadores_comite(filas, p):
    """Dinero y distribución del inventario en piso. filas: dict con 'u' (unidad) y 'e' (resultado de evaluar)."""
    n = len(filas)
    nombres = nombres_tramos(p)
    por_tramo = {t: 0 for t in nombres}
    capital_tramo = {t: 0.0 for t in nombres}
    por_sem = {"verde": 0, "amarillo": 0, "rojo": 0}
    viejas = [f for f in filas if f["e"]["dias"] > p["tramos"][3]]
    for f in filas:
        t = nombres[f["e"]["tramo"]]
        por_tramo[t] += 1
        capital_tramo[t] += _base_costo(f["u"])
        por_sem[f["e"]["semaforo"]] += 1
    return dict(
        unidades=n,
        dias_promedio=(sum(f["e"]["dias"] for f in filas) / n) if n else None,
        pct_mas_120=(len(viejas) / n) if n else None,
        capital_inmovilizado=sum(_base_costo(f["u"]) for f in filas),
        costo_diario_total=sum(f["e"]["costo_diario"] for f in filas),
        utilidad_potencial=sum(f["e"]["utilidad_publicado"] for f in filas),
        por_tramo=por_tramo, capital_por_tramo=capital_tramo, por_semaforo=por_sem,
        n_mas_120=len(viejas), costo_acumulado_mas_120=sum(f["e"]["costo_acumulado"] for f in viejas))


def beneficio_venta(u, p):
    """Beneficio de una unidad vendida antes del límite de antigüedad (tramos[3], 120 días): margen recuperado
    (precio de venta − costo acumulado) + costo de capital evitado (días que faltaban hasta el límite × capital y
    seguro por día). Las vendidas pasado el límite no suman. Devuelve None si no cuenta."""
    d = dias_en_piso(u)
    if d > p["tramos"][3] or u.get("precio_venta") is None:
        return None
    a = _componentes_auto(u, p)
    margen = u["precio_venta"] - costo_acumulado(u, d, p)
    evitado = (p["tramos"][3] - d) * (a["capital"] + a["seguro"])
    return dict(dias=d, margen=margen, capital_evitado=evitado, total=margen + evitado)


def _avance(valor, base, meta, menos_es_mejor):
    """Fracción del camino recorrido de la línea base a la meta (1 = meta cumplida)."""
    if valor is None:
        return None
    if menos_es_mejor:
        return 1.0 if valor <= meta else max((base - valor) / (base - meta), 0.0) if base > meta else 0.0
    return min(valor / meta, 9.99) if meta else 1.0


def estado_avance(a):
    """ok = cumple, cerca = recorrió al menos la mitad del camino, lejos = menos."""
    return None if a is None else "ok" if a >= 1 else "cerca" if a >= 0.5 else "lejos"


def objetivos(en_piso, vendidas, cambios, p, hoy=None, ventana=VENTANA_OBJETIVOS):
    """Las cuatro metas del caso. en_piso: [{'u','e'}]; vendidas: unidades vendidas (cualquier fecha);
    cambios: cambios de precio de la ventana [{'precio_nuevo','precio_sugerido','aprobado'}]."""
    hoy = _fecha(hoy or date.today())
    desde = hoy - timedelta(days=ventana)
    recientes = [u for u in vendidas if u.get("fecha_venta") and _fecha(u["fecha_venta"]) >= desde]
    n_piso = len(en_piso)
    out = []

    d_ven = [dias_en_piso(u) for u in recientes]
    d_piso = [f["e"]["dias"] for f in en_piso]
    v = (sum(d_ven) / len(d_ven)) if d_ven else None
    a = _avance(v, p["base_dias_promedio"], p["meta_dias_promedio"], True)
    out.append(dict(clave="dias", nombre="Días promedio en piso", formato="dias", valor=v, meta=p["meta_dias_promedio"],
                    base=p["base_dias_promedio"], avance=a, estado=estado_avance(a), menos_es_mejor=True,
                    detalle=(f"{len(d_ven)} vendidas en los últimos {ventana} días" if d_ven else f"Sin ventas en los últimos {ventana} días")
                    + (f" · en piso hoy: {sum(d_piso) / n_piso:.0f} d" if n_piso else "")))

    viejas = sum(x > p["tramos"][3] for x in d_piso)
    v = (viejas / n_piso) if n_piso else None
    a = _avance(v, p["base_pct_mas_120"], p["meta_pct_mas_120"], True)
    out.append(dict(clave="mas120", nombre=f"Unidades con más de {p['tramos'][3]} días", formato="pct", valor=v,
                    meta=p["meta_pct_mas_120"], base=p["base_pct_mas_120"], avance=a, estado=estado_avance(a),
                    menos_es_mejor=True, detalle=f"{viejas} de {n_piso} unidades en piso"))

    dentro = sum(1 for c in cambios if c.get("precio_sugerido") and
                 (abs(c["precio_nuevo"] / c["precio_sugerido"] - 1) <= p["tolerancia_excepcion"] or c.get("aprobado") == 1))
    v = (dentro / len(cambios)) if cambios else None
    a = _avance(v, 0, p["meta_pct_en_regla"], False)
    out.append(dict(clave="regla", nombre="Cambios de precio dentro de la regla", formato="pct", valor=v,
                    meta=p["meta_pct_en_regla"], base=None, avance=a, estado=estado_avance(a), menos_es_mejor=False,
                    detalle=(f"{dentro} de {len(cambios)} en los últimos {ventana} días (dentro de ±{p['tolerancia_excepcion'] * 100:.0f} % "
                             f"del sugerido o con excepción aprobada)") if cambios else f"Sin cambios de precio en los últimos {ventana} días"))

    ben = [b for b in (beneficio_venta(u, p) for u in recientes) if b]
    periodo = sum(b["total"] for b in ben)
    anual = periodo * 365 / ventana
    a = _avance(anual, 0, p["meta_beneficio_anual"], False) if ben else None
    out.append(dict(clave="beneficio", nombre="Beneficio acumulado (margen + capital)", formato="usd", valor=anual if ben else None,
                    meta=p["meta_beneficio_anual"], base=None, avance=a, estado=estado_avance(a), menos_es_mejor=False,
                    periodo=periodo, margen=sum(b["margen"] for b in ben), capital_evitado=sum(b["capital_evitado"] for b in ben),
                    detalle=(f"{usd(periodo)} en {ventana} días ({len(ben)} ventas antes de {p['tramos'][3]} d) llevados a un año"
                             if ben else f"Sin ventas antes de {p['tramos'][3]} días en los últimos {ventana} días")))
    return out
