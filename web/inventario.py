"""Motor de inventario y precio dinámico (funciones puras, sin servidor ni base de datos).

Principio (regla v3): el ajuste de precio siempre busca ganar algo. El precio sugerido sale del margen objetivo del
tramo de días (sobre el costo BASE, para que no suba solo porque pasan los días) con el tope del MERCADO (modelo
XGBoost o referencia manual), y nunca queda bajo el piso de ganancia (costo acumulado + margen mínimo) mientras el
mercado lo permita. Solo se sugiere un precio con pérdida cuando el costo acumulado ya supera lo que paga el mercado.

Una unidad es un dict con: marca, familia, version, modelo, anio, km, fecha_ingreso, costo_compra,
reacondicionamiento, precio_publicado, ultima_revision (y los campos del auto que usa el modelo).
"""
import math
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

DIAS_CURVA = 210            # largo mínimo de la curva de mercado (una sola predicción en lote)
FECHA_AVISOS = (10, 1)      # mes y día de los avisos de Patio Tuerca con que se entrenó el modelo (1-oct del año de referencia)
DEPRECIACION_RESPALDO = 0.06    # caída anual que se usa si el modelo, por ruido, da más valor a un año más de edad
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
    # Costo de esperar = solo el costo de capital (Entrega 1): 12 % × (compra + reacondicionamiento) ÷ 365.
    # Seguro, patio y lavado NO están en la Entrega 1: quedan en 0 y solo cuentan si se activa el interruptor
    # (análisis de sensibilidad).
    tasa_capital_anual=0.12,        # costo del capital inmovilizado (dato de la empresa)
    costos_adicionales=False,       # interruptor: ¿contar seguro, patio y lavado?
    tasa_seguro_anual=0.0,          # seguro (supuesto; solo con el interruptor activado)
    costo_espacio_diario=0.0,       # USD por día de patio (supuesto; solo con el interruptor activado)
    costo_lavado_diario=0.0,        # USD por día de lavado y mantenimiento (supuesto; solo con el interruptor activado)
    fuentes=dict(tasa_capital_anual="empresa", tasa_seguro_anual="supuesto", costo_espacio_diario="supuesto",
                 costo_lavado_diario="supuesto"),     # de dónde sale cada valor: "empresa" o "supuesto"
    dias_revision=7,                # cada cuántos días se debe revisar el precio
    tramos=[30, 60, 90, 120],       # límites de los tramos: 0–30 / 31–60 / 61–90 / 91–120 / >120
    # regla de precio v3 (márgenes por antigüedad de la empresa y prototipo del grupo)
    margen_minimo=0.03,             # piso de ganancia = costo acumulado × (1 + margen mínimo)
    margenes=[0.12, 0.10, 0.09, 0.07, 0.05],        # margen objetivo sobre el costo base, por tramo
    topes=[0.03, 0.0, -0.02, -0.04, -0.06],         # tope del precio frente al valor de mercado, por tramo
    stock_umbrales=[3, 5],          # unidades en piso de la misma familia desde las que baja el margen objetivo
    stock_ajustes=[0.01, 0.02],     # cuánto baja (1 y 2 puntos)
    banda_negociacion=0.03,         # mínimo y máximo alrededor del precio objetivo
    dias_espera=232,                # "camino 2": promedio de días de las unidades que pasan de 120 (Entregable 1)
    margen_espera=0.032,            # margen con que se venden esas unidades (Entregable 1)
    tolerancia_banda=0.03,          # holgura alrededor de [bajo50, alto50]
    tolerancia_excepcion=0.03,      # solo para cambios anteriores a la v3 (sin banda guardada)
    # objetivos del caso (Tablero de objetivos)
    # metas del business case: línea base, meta 2028 (la que se vigila hoy) y meta 2029
    base_dias_promedio=75, meta_dias_2028=68, meta_dias_2029=61,           # días promedio en inventario
    meta_dias_empresa=65,                                                  # referencia: meta de la empresa
    base_pct_mas_120=0.178, meta_pct_mas_120_2028=0.133, meta_pct_mas_120_2029=0.089,   # % de unidades con más de 120 días
    meta_pct_en_regla_2028=0.90, meta_pct_en_regla_2029=1.0,               # % de cambios de precio dentro de la regla
    meta_beneficio_2028=183540.0, meta_beneficio_2029=367080.0,            # USD al año (2028: comprometido)
    # business case de la Entrega 1 (sección 3.2 y Tabla 3): beneficio por unidad que deja de superar 120 días
    margen_61_90=0.096,             # margen de una unidad vendida entre los días 61 y 90 (después de 120 días: margen_espera, 3,2 %)
    precio_referencia=17500.0,      # precio de referencia sobre el que se calcula el margen recuperado
    costo_referencia=15715.0,       # costo de compra de referencia (12 % ÷ 365 = USD 5,17 por día)
    ventas_mas_120_anuales=379.0,   # unidades al año que superan 120 días (deducido de la Tabla 3: 25 % = 95, 50 % = 190, 75 % = 284)
)
VENTANA_OBJETIVOS = 90      # días hacia atrás que miran los objetivos
# Valores que se sugieren al activar los costos adicionales (supuestos de la v3; no están en la Entrega 1)
ADICIONALES_SENSIBILIDAD = dict(tasa_seguro_anual=0.02, costo_espacio_diario=2.0, costo_lavado_diario=1.0)


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
    if "costos_adicionales" not in q:       # parámetros guardados antes de la v4: seguro, patio y lavado vuelven a 0 (Entrega 1)
        for k in ("tasa_seguro_anual", "costo_espacio_diario", "costo_lavado_diario"):
            q.pop(k, None)
    p = {**PARAMS_DEF, **q}
    p["costos_adicionales"] = p["costos_adicionales"] in (True, 1, "1", "true", "True")
    try:
        for k in ["tasa_capital_anual", "tasa_seguro_anual", "costo_espacio_diario", "costo_lavado_diario", "margen_minimo",
                  "banda_negociacion", "margen_espera",
                  "tolerancia_banda", "tolerancia_excepcion", "base_dias_promedio", "meta_dias_2028", "meta_dias_2029",
                  "meta_dias_empresa", "base_pct_mas_120", "meta_pct_mas_120_2028", "meta_pct_mas_120_2029",
                  "meta_pct_en_regla_2028", "meta_pct_en_regla_2029", "meta_beneficio_2028", "meta_beneficio_2029",
                  "margen_61_90", "precio_referencia", "costo_referencia", "ventas_mas_120_anuales"]:
            p[k] = float(p[k])
            if p[k] < 0:
                raise ValueError
        for k in ["tasa_capital_anual", "tasa_seguro_anual", "base_pct_mas_120", "meta_pct_mas_120_2028",
                  "meta_pct_mas_120_2029", "meta_pct_en_regla_2028", "meta_pct_en_regla_2029",
                  "margen_minimo", "banda_negociacion", "margen_espera", "margen_61_90"]:
            if p[k] > 1:
                raise ValueError(f"{k.replace('_', ' ').capitalize()} debe ir como porcentaje entre 0 y 100")
        f = {**PARAMS_DEF["fuentes"], **(p.get("fuentes") or {})}
        p["fuentes"] = {k: (f[k] if f[k] in ("empresa", "supuesto") else "supuesto") for k in PARAMS_DEF["fuentes"]}
        p["dias_revision"] = int(p["dias_revision"])
        p["tramos"] = [int(x) for x in p["tramos"]]
        p["margenes"] = [float(x) for x in p["margenes"]]
        p["topes"] = [float(x) for x in p["topes"]]
        p["stock_umbrales"] = [int(x) for x in p["stock_umbrales"]]
        p["stock_ajustes"] = [float(x) for x in p["stock_ajustes"]]
        p["dias_espera"] = int(p["dias_espera"])
    except (TypeError, ValueError) as e:
        raise ValueError(str(e) if str(e).endswith("100") else "Los parámetros deben ser números válidos (no negativos)")
    if len(p["tramos"]) != 4 or p["tramos"] != sorted(set(p["tramos"])) or p["tramos"][0] < 1:
        raise ValueError("Los límites de tramo deben ser 4 días distintos y crecientes")
    if len(p["margenes"]) != 5 or any(a < 0 or a > 1 for a in p["margenes"]):
        raise ValueError("Los márgenes objetivo deben ser 5 porcentajes entre 0 y 100")
    if len(p["topes"]) != 5 or any(a > 0.5 or a < -0.9 for a in p["topes"]):
        raise ValueError("Los topes frente al mercado deben ser 5 porcentajes razonables")
    if len(p["stock_umbrales"]) != 2 or p["stock_umbrales"] != sorted(set(p["stock_umbrales"])) or p["stock_umbrales"][0] < 2 \
            or len(p["stock_ajustes"]) != 2 or any(a < 0 or a > 0.5 for a in p["stock_ajustes"]):
        raise ValueError("El ajuste por stock necesita 2 cantidades crecientes (desde 2) y 2 porcentajes")
    if p["dias_espera"] <= p["tramos"][3]:
        raise ValueError("Los días del camino de espera deben ser más que el último tramo")
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
    on = bool(p.get("costos_adicionales"))        # seguro, patio y lavado solo cuentan con el interruptor activado
    # el costo diario se redondea a centavos, como en la Entrega 1 (USD 5,17 por día, no 5,1666…)
    return dict(capital=round(base * p["tasa_capital_anual"] / 365, 2),
                seguro=round(base * p["tasa_seguro_anual"] / 365, 2) if on else 0.0,
                espacio=p["costo_espacio_diario"] if on else 0.0, lavado=p["costo_lavado_diario"] if on else 0.0)


def costo_diario(u, p):
    """USD por día de la unidad: solo el capital (12 % × (compra + reacondicionamiento) ÷ 365); seguro, patio y lavado se
    suman únicamente con los costos adicionales activados.
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
        if k != "capital" and manual is None and not auto[k]:      # en 0 (Entrega 1) no aparecen en el desglose
            continue
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

    El modelo aprendió la antigüedad en años enteros (edad = año de los avisos − año del carro), así que predecir
    con edad fraccionaria daba una línea plana. Aquí se predice con la edad entera y con la siguiente (mismo km: el
    carro está parado) y cada día se interpola en escala logarítmica:
        mercado(d) = exp((1 − f) × ln V(e0) + f × ln V(e0 + 1)),  e = edad en años ese día, e0 = floor(e), f = e − e0
    La edad se mide desde la fecha de los avisos con que se entrenó el modelo (FECHA_AVISOS): ese día el valor es
    exactamente el del cotizador, y de ahí en adelante baja un poco cada día. Igual para bajo50 y alto50. Si por
    ruido V(e0 + 1) > V(e0), se usa V(e0) × (1 − 6 %) (DEPRECIACION_RESPALDO). Al final se suaviza para que nunca suba."""
    import numpy as np
    import pandas as pd
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "xgboost"))
    import pricing_ml as P

    k = max(P.ANIO_REF - int(u["anio"]), 0)                     # edad con que el modelo ve hoy a este carro
    desde_avisos = (_fecha(u["fecha_ingreso"]) - date(P.ANIO_REF, *FECHA_AVISOS)).days
    dias = np.arange(hasta + 1)
    e = np.clip(k + (desde_avisos + dias) / 365, 0, None)
    e0 = np.floor(e).astype(int)
    f = e - e0
    edades = np.arange(e0.min(), e0.max() + 2)                  # edades enteras necesarias (2 o 3 filas)
    km, pn = u.get("km"), u.get("pn_con_iva")
    df = pd.DataFrame(dict(marca=u["marca"], familia=u["familia"], version=u.get("version"), modelo=u.get("modelo"),
                           **{c: u.get(c) for c in CAMPOS_MODELO}, edad=edades.astype(float),
                           km=km if km is not None else np.nan,
                           km_anio=(km / np.maximum(edades, 1)) if km is not None else np.nan,
                           cilindraje=u.get("cilindraje") or np.nan,
                           pn_sin_iva=(pn / P.IVA) if pn else np.nan))
    X = P.matriz(df, art["cats"])
    mu = np.asarray(art["modelo"].predict(X), dtype=float)
    q50 = np.asarray(art["q50"] * P.sigma(art["dificultad"], X), dtype=float)
    for j in range(1, len(mu)):                                 # un año más nunca vale más
        if mu[j] > mu[j - 1]:
            mu[j] = mu[j - 1] + math.log(1 - DEPRECIACION_RESPALDO)
    i = e0 - edades[0]
    interp = lambda a: (1 - f) * a[i] + f * a[i + 1]            # interpolación de logaritmos
    c = pd.DataFrame(dict(d=dias, mercado=np.exp(interp(mu)), bajo50=np.exp(interp(mu - q50)),
                          alto50=np.exp(interp(mu + q50))))
    c = P._suavizar_decreciente(c, "d", ["mercado", "bajo50", "alto50"])
    modelo = c.to_dict("records")
    ref = referencia_unidad(u)
    if ref["tipo"] == "apendice":                       # referencia de la Entrega 1: el modelo queda como segunda opinión
        return curva_apendice(modelo, ref["p"])
    return escalar_curva(modelo, u.get("mercado_manual"))    # referencia manual o respaldo del modelo


# ----------------------------------------------------------------------------- referencia de mercado (Apéndice E, Entrega 1)
# Mediana, por familia y año, de los anuncios de Patiotuerca y Autocor del 7-oct-2026 (datos_caso/reconstruir_referencias.py).
# Prioridad: 1) referencia manual de la unidad, 2) Apéndice E, 3) modelo XGBoost como respaldo.
REF_ARCHIVO = Path(__file__).resolve().parent / "datos_caso" / "referencias_apendice_e.json"
MARCAS_REF = {"COROLLA": ("toyota",), "FORTUNER": ("toyota",), "HILUX": ("toyota",), "RAV4": ("toyota",), "YARIS": ("toyota",),
              "RUSH": ("toyota",), "RAIZE": ("toyota",), "SPORTAGE": ("kia",), "2008": ("peugeot",), "SWIFT": ("suzuki",),
              "D-MAX": ("chevrolet", "isuzu")}      # marcas del catálogo que corresponden a cada familia del Apéndice E
_REF_CACHE = {}


def tabla_referencias():
    """{'COROLLA': {'2023': {'p': 21800, 'n': 1}, ...}, ...} (vacía si falta el archivo)."""
    if "t" not in _REF_CACHE:
        import json
        _REF_CACHE["t"] = json.loads(REF_ARCHIVO.read_text(encoding="utf-8"))["ref"] if REF_ARCHIVO.exists() else {}
    return _REF_CACHE["t"]


def _norm_fam(s):
    import re
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def referencia_apendice(u, tabla=None):
    """Referencia del Apéndice E para la unidad, o None si la familia no está en la muestra.
    Año exacto -> su mediana. Si no, el año más cercano ajustado 6 % por año de diferencia (más nuevo que el disponible:
    p ÷ 0,94^dif; más viejo: p × 0,94^dif), redondeado a USD 10. Si hay empate de cercanía, gana el año más viejo
    (igual que la función referencia() del prototipo del compañero). Las versiones 'cross' (Corolla Cross, Yaris Cross)
    son SUV, no el sedán de la muestra: quedan fuera."""
    tabla = tabla_referencias() if tabla is None else tabla
    if "cross" in str(u.get("version") or "").lower():
        return None
    texto = str(u.get("familia") or "").split(" ", 1)[-1]
    clave = next((k for k in tabla if _norm_fam(k) == _norm_fam(texto)), None)
    if clave is None or str(u.get("marca") or "").lower() not in MARCAS_REF.get(clave, (str(u.get("marca") or "").lower(),)):
        return None
    por_anio = tabla[clave]
    anio = int(u["anio"])
    if str(anio) in por_anio:
        d = por_anio[str(anio)]
        return dict(tipo="apendice", p=float(d["p"]), n=int(d["n"]), exacta=True, anio_base=anio, familia=clave)
    base = min(sorted(int(a) for a in por_anio), key=lambda a: abs(a - anio))
    d, dif = por_anio[str(base)], abs(base - anio)
    f = (1 - DEPRECIACION_RESPALDO) ** dif
    p = d["p"] * f if base > anio else d["p"] / f
    return dict(tipo="apendice", p=float(_r10(p)), n=int(d["n"]), exacta=False, anio_base=base, familia=clave)


def referencia_unidad(u, tabla=None):
    """Qué referencia de mercado usa la unidad y de dónde sale (siempre trae 'tipo' y 'fuente')."""
    if u.get("mercado_manual") not in (None, ""):
        return dict(tipo="manual", p=float(u["mercado_manual"]), fuente="Manual")
    r = referencia_apendice(u, tabla)
    if r:
        r["fuente"] = (f"Apéndice E · mediana de {r['n']} anuncio{'' if r['n'] == 1 else 's'}" if r["exacta"]
                       else f"Apéndice E · ajustado desde {r['anio_base']} (6 % anual)")
        r["nivel"] = nivel_apendice(r)
        return r
    return dict(tipo="modelo", fuente="Modelo (respaldo)",
                etiqueta="Estimación del modelo (este modelo no está en la muestra del Apéndice E)")


def nivel_apendice(r):
    """Confianza de una referencia del Apéndice E: alta con 5 o más anuncios del año exacto, media con 2–4, baja con 1
    anuncio o con año ajustado."""
    if not r["exacta"] or r["n"] <= 1:
        return "baja"
    return "alta" if r["n"] >= 5 else "media"


def texto_confianza_apendice(r):
    n = r["n"]
    if r["exacta"]:
        base = f"{n} anuncio{'' if n == 1 else 's'} del año exacto en la muestra del Apéndice E"
    else:
        base = f"no hay anuncios del año en el Apéndice E; se ajustó desde {r['anio_base']} (6 % anual)"
    nivel = r["nivel"] if "nivel" in r else nivel_apendice(r)
    if nivel == "alta":
        return f"Confianza alta: {base}."
    return f"Confianza {nivel}: {base}." + (" Revise los comparables y fije una referencia manual." if nivel == "baja" else "")


def curva_apendice(modelo, p):
    """mercado(d) = referencia × 0,94^(d/365) (la misma depreciación de 6 % anual de la Entrega 1). El rango probable
    conserva la proporción que da el modelo ese día; el valor del modelo queda en 'modelo' como segunda opinión."""
    out = []
    for c in modelo:
        m = p * (1 - DEPRECIACION_RESPALDO) ** (c["d"] / 365)
        out.append({**c, "modelo": c["mercado"], "modelo_bajo50": c["bajo50"], "modelo_alto50": c["alto50"], "mercado": m,
                    "bajo50": m * c["bajo50"] / c["mercado"], "alto50": m * c["alto50"] / c["mercado"]})
    return out


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


# ----------------------------------------------------------------------------- precio sugerido (regla v3)
# El ajuste siempre busca ganar algo: el precio sugerido nunca queda bajo el piso de ganancia (costo acumulado +
# margen mínimo) mientras el mercado lo permita. Solo se sugiere un precio con pérdida cuando el costo acumulado ya
# supera lo que paga el mercado.
CASOS = dict(con_ganancia="Con ganancia", ganancia_minima="Ganancia mínima", ganancia_reducida="Ganancia reducida",
             perdida_inevitable="Pérdida inevitable")
ESTADOS_TRAMO = [("verde", "Normal"), ("verde", "Normal"), ("amarillo", "Ventana de venta"), ("naranja", "Alerta"),
                 ("rojo", "Crítico")]
ACCIONES_TRAMO = ["Precio de lanzamiento. Publicar y medir visitas y leads.",
                  "Primer ajuste. Revisar fotos, descripción y posición en la web.",
                  "Ventana objetivo. Ajustar el precio hoy y destacar la unidad.",
                  "Llevar al comité de esta semana antes de cruzar los 120 días.",
                  "Vender con el piso de ganancia; evaluar traslado de agencia o canal alterno."]


def _r10(x):
    return math.floor(x / 10 + 0.5) * 10


def _abajo10(x):
    return math.floor(x / 10 + 1e-9) * 10


def _arriba10(x):
    return math.ceil(x / 10 - 1e-9) * 10


def ajuste_stock(n, p):
    """Puntos de margen que se restan cuando hay varias unidades en piso de la misma familia (3 o más, 5 o más)."""
    aj = 0.0
    for umbral, a in zip(p["stock_umbrales"], p["stock_ajustes"]):
        if n >= umbral:
            aj = a
    return aj


def precio_regla(u, d, c, p, stock=1):
    """Regla de precio para el día d (c = fila de la curva de mercado de ese día; stock = unidades en piso de la
    misma familia). Devuelve el precio (redondeado a USD 10), el caso que aplicó y la banda de negociación.

      objetivo_margen = costo_base × (1 + margen del tramo − ajuste por stock)   (sobre el costo BASE: el precio
                        no sube solo porque pasan los días)
      tope_mercado    = mercado(d) × (1 + tope del tramo)
      1. candidato = min(objetivo_margen, tope_mercado)
      2. candidato ≥ piso_ganancia            -> con_ganancia:       precio = candidato
      3. tope_mercado ≥ piso_ganancia         -> ganancia_minima:    precio = piso_ganancia
      4. mercado ≥ equilibrio                 -> ganancia_reducida:  precio = max(equilibrio, min(piso, mercado))
      5. mercado < equilibrio                 -> perdida_inevitable: precio = tope_mercado
    (Si el mercado queda bajo el equilibrio pero el tope del primer tramo, +3 %, todavía lo alcanza, se vende al
    tope sin pérdida: cuenta como ganancia reducida.)"""
    t = tramo(d, p)
    base, eq = _base_costo(u), costo_acumulado(u, d, p)
    piso = eq * (1 + p["margen_minimo"])
    aj = ajuste_stock(stock, p)
    objetivo = base * (1 + p["margenes"][t] - aj)
    m = c["mercado"]
    tope = m * (1 + p["topes"][t])
    cand = min(objetivo, tope)
    b = p["banda_negociacion"]
    if cand >= piso:
        caso, precio = "con_ganancia", _r10(cand)
        if precio < piso:
            precio = _arriba10(piso)
        minimo = _arriba10(max(precio * (1 - b), piso))
    elif tope >= piso:
        caso, precio = "ganancia_minima", _arriba10(piso)
        minimo = precio
    elif max(m, tope) >= eq:
        caso, precio = "ganancia_reducida", _r10(max(eq, min(piso, m if m >= eq else tope)))
        if precio < eq:
            precio = _arriba10(eq)
        minimo = _arriba10(eq)
    else:
        caso, precio = "perdida_inevitable", _r10(tope)
        minimo = precio                                 # sin margen para negociar sin el comité
    minimo = min(minimo, precio)
    maximo = max(precio, _abajo10(min(precio * (1 + b), tope)))
    return dict(tramo=t, caso=caso, precio=float(precio), minimo=float(minimo), maximo=float(maximo), equilibrio=eq,
                piso_ganancia=piso, objetivo_margen=objetivo, tope_mercado=tope, margen_tramo=p["margenes"][t],
                tope_tramo=p["topes"][t], ajuste_stock=aj, mercado=m, limita="margen" if objetivo <= tope else "mercado")


def serie(u, curva, p, hasta=None, stock=1):
    """Una fila por día para el gráfico: equilibrio (costo acumulado), piso de ganancia, mercado, banda y precio de
    la regla (con el objetivo por margen y el tope de mercado como series secundarias)."""
    filas = []
    for c in curva[: (hasta + 1) if hasta else None]:
        r = precio_regla(u, c["d"], c, p, stock)
        filas.append(dict(d=c["d"], costo=r["equilibrio"], piso=r["piso_ganancia"], mercado=c["mercado"],
                          bajo50=c["bajo50"], alto50=c["alto50"], sugerido=r["precio"], minimo=r["minimo"],
                          maximo=r["maximo"], objetivo=r["objetivo_margen"], tope=r["tope_mercado"], caso=r["caso"],
                          modelo=c.get("modelo")))
    return filas


def dia_equilibrio(u, curva, p):
    """Primer día en que el valor de mercado ya no cubre el costo acumulado (None si no ocurre en la curva)."""
    for c in curva:
        if c["mercado"] <= costo_acumulado(u, c["d"], p):
            return c["d"]
    return None


def es_excepcion(c, tolerancia):
    """¿El cambio de precio c quedó fuera de la regla? Fuera de la banda [mínimo, máximo] que tenía ese día; los
    cambios anteriores a la v3 (sin banda guardada) usan la regla vieja: más de la tolerancia frente al sugerido."""
    if c.get("precio_minimo") is not None and c.get("precio_maximo") is not None:
        return not (c["precio_minimo"] - 0.5 <= c["precio_nuevo"] <= c["precio_maximo"] + 0.5)
    return bool(c.get("precio_sugerido")) and abs(c["precio_nuevo"] / c["precio_sugerido"] - 1) > tolerancia


def segunda_opinion(ref, mercado, modelo):
    """Compara el valor del modelo con la referencia usada. Solo aplica cuando la referencia viene del Apéndice E o es manual."""
    if ref is None or ref["tipo"] == "modelo" or not modelo or not mercado:
        return None
    dif = modelo / mercado - 1
    return dict(valor=modelo, dif=dif, aviso=abs(dif) > 0.10,
                texto=f"El modelo estima {usd(modelo)} ({abs(dif) * 100:.0f} % de diferencia)"
                      + (" · supera 10 %: revise la referencia" if abs(dif) > 0.10 else ""))


def evaluar(u, curva, p, hoy=None, n_comparables=None, conf=None, stock=1, ref=None):
    """Todos los cálculos de una unidad para el día de hoy.
    conf: confianza del valor de mercado ({'nivel', 'texto', ...}); con confianza baja y sin referencia manual el
    semáforo no puede ser verde y la recomendación lleva el aviso.
    stock: unidades en piso de la misma familia (contando esta)."""
    hoy = _fecha(hoy or date.today())
    d = dias_en_piso(u, hoy)
    c = curva[min(d, len(curva) - 1)]
    pub = u["precio_publicado"]
    tol = p["tolerancia_banda"]
    r = precio_regla(u, d, c, p, stock)
    t, caso, s, eq, piso = r["tramo"], r["caso"], r["precio"], r["equilibrio"], r["piso_ganancia"]
    minimo, maximo = r["minimo"], r["maximo"]
    m, lo, hi = c["mercado"], c["bajo50"], c["alto50"]
    base, cd, mm = _base_costo(u), costo_diario(u, p), p["margen_minimo"]
    nombre_t = nombres_tramos(p)[t]

    dentro = lo * (1 - tol) <= pub <= hi * (1 + tol)             # frente al rango probable de mercado
    en_banda = minimo - 0.5 <= pub <= maximo + 0.5               # frente a la banda de negociación de la regla
    ult = _fecha(u.get("ultima_revision") or u["fecha_ingreso"])
    vencida = (hoy - ult).days > p["dias_revision"]

    de = dia_equilibrio(u, curva, p)
    util_pub, util_sug = pub - eq, s - eq
    d30 = min(d + 30, len(curva) - 1)
    r30 = precio_regla(u, d30, curva[d30], p, stock)
    util_espera = r30["precio"] - r30["equilibrio"]              # utilidad si se espera 30 días y se vende a la regla

    # --- explicación del caso, en una frase
    if caso == "con_ganancia":
        if r["limita"] == "margen":
            frase = (f"El tramo {nombre_t} días pide {pct_txt(r['margen_tramo'])} sobre el costo"
                     + (f" (menos {r['ajuste_stock'] * 100:g} punto{'' if r['ajuste_stock'] == 0.01 else 's'} porque hay "
                        f"{stock} unidades de la misma familia)" if r["ajuste_stock"] else "")
                     + f": deja {usd(util_sug)} sobre el costo acumulado.")
        else:
            frase = (f"Manda el tope de mercado del tramo {nombre_t} días ({r['tope_tramo'] * 100:+.0f} % sobre {usd(m)}): "
                     f"deja {usd(util_sug)} sobre el costo acumulado.").replace("+0 %", "0 %")
    elif caso == "ganancia_minima":
        frase = f"No se baja de {usd(s)}: es el costo acumulado ({usd(eq)}) más {pct_txt(mm)} de margen mínimo."
    elif caso == "ganancia_reducida":
        frase = (f"El mercado ({usd(m)}) ya no alcanza para el margen mínimo de {pct_txt(mm)}: vender a {usd(s)} deja "
                 f"{usd(util_sug)}, sin pérdida.")
    else:
        frase = (f"El costo acumulado ({usd(eq)}) ya supera el valor de mercado ({usd(m)}): vender hoy pierde "
                 f"{usd(-util_sug)}; esperar 30 días más perdería unos {usd(-util_espera)}.")

    # --- recomendación frente al precio publicado
    if pub < s and not en_banda:
        rec = "Subir"
        por = "bajo el rango de mercado" if pub < lo * (1 - tol) else \
            "bajo el piso de ganancia" if pub < piso and caso != "perdida_inevitable" else "bajo el mínimo de la banda"
        texto = f"Lleva {d} días y el publicado ({usd(pub)}) está {por}; subir a {usd(s)}. {frase}"
    elif pub > maximo + 0.5:
        rec = "Liquidar" if caso == "perdida_inevitable" else "Bajar"
        texto = (f"Lleva {d} días; vender a {usd(s)}. {frase}" if rec == "Liquidar" else
                 f"Lleva {d} días y el publicado ({usd(pub)}) supera el máximo de la banda ({usd(maximo)}); bajar a {usd(s)}. {frase}")
    else:
        rec = "Mantener"
        texto = (f"Lleva {d} días y el publicado ({usd(pub)}) está dentro de la banda {usd(minimo)} – {usd(maximo)}; "
                 f"mantener. {frase}")

    # --- semáforo: el estado del tramo; rojo si hay pérdida; un verde con pendientes pasa a amarillo
    sem, estado = ESTADOS_TRAMO[t]
    if caso == "perdida_inevitable" or pub < eq:
        sem = "rojo"
    manual = u.get("mercado_manual") is not None
    aviso = None
    if conf and conf["nivel"] == "baja" and not manual:
        aviso = conf["texto"]
        texto += " Ojo: confianza baja en el valor de mercado."
    if sem == "verde" and (vencida or not en_banda or aviso):
        sem = "amarillo"

    # --- banda de negociación: mínimo · objetivo · máximo, con lo que deja cada uno
    banda = [dict(clave=k, nombre=n, precio=v, utilidad=v - eq, pct=(v - eq) / eq if eq else None)
             for k, n, v in (("minimo", "Mínimo", minimo), ("objetivo", "Objetivo", s), ("maximo", "Máximo", maximo))]

    # --- los dos caminos: vender hoy o seguir esperando
    dias_esp, margen_esp = int(p["dias_espera"]), p["margen_espera"]
    if d < dias_esp:
        extra = dias_esp - d
        esperar = base * margen_esp - cd * extra
        caminos = dict(modo="espera_larga", dias_extra=extra, hasta_dia=dias_esp, margen_espera=margen_esp,
                       margen_usd=base * margen_esp, costo_espera=cd * extra)
    else:
        extra, esperar = d30 - d, util_espera
        caminos = dict(modo="30_dias", dias_extra=extra, hasta_dia=d30, costo_espera=cd * extra)
    caminos.update(vender_hoy=util_sug, esperar=esperar, diferencia=util_sug - esperar)

    return dict(
        dias=d, tramo=t, tramo_nombre=nombre_t, estado=estado, accion_comercial=ACCIONES_TRAMO[t],
        costo_diario=cd, costo_base=base, costo_acumulado=eq, equilibrio=eq, piso_ganancia=piso, piso=piso,
        mercado=m, bajo50=lo, alto50=hi, pct_vs_mercado=pub / m - 1, sugerido=s, minimo=minimo, maximo=maximo,
        caso=caso, caso_nombre=CASOS[caso], frase_caso=frase, objetivo_margen=r["objetivo_margen"],
        tope_mercado=r["tope_mercado"], margen_tramo=r["margen_tramo"], tope_tramo=r["tope_tramo"],
        ajuste_stock=r["ajuste_stock"], stock=stock, limita=r["limita"], banda=banda, caminos=caminos,
        mercado_modelo=c.get("modelo", m), referencia_manual=manual, confianza=conf, aviso_confianza=aviso,
        referencia=dict(ref or referencia_unidad(u), segunda_opinion=segunda_opinion(ref or referencia_unidad(u), m, c.get("modelo"))),
        recomendacion=rec, texto=texto, dentro_banda=dentro, en_banda=en_banda, revision_vencida=vencida,
        dia_equilibrio=de,
        fecha_equilibrio=(_fecha(u["fecha_ingreso"]) + timedelta(days=de)).isoformat() if de is not None else None,
        dias_hasta_equilibrio=(de - d) if de is not None else None,
        utilidad_publicado=util_pub, utilidad_sugerido=util_sug, utilidad_espera_30=util_espera,
        perdida_hoy=-util_sug if util_sug < 0 else 0.0, semaforo=sem, n_comparables=n_comparables)


FAMILIAS_CON_CROSS = ("corolla", "yaris")        # "Cross" es un SUV distinto del sedán/hatchback de la misma familia


def es_cross(texto):
    return "cross" in str(texto or "").lower()


# ----------------------------------------------------------------------------- Calculadora de precio (v5)
def escalera(u, curva, p, d, stock=1):
    """Precio objetivo que daría la regla en cada tramo (días 30, 60, 90, 120 y 150, como la calculadora del grupo); el tramo
    actual usa el día de hoy, así que su bloque coincide con el precio sugerido. Margen sobre el costo acumulado de ese día."""
    t_act, nombres = tramo(d, p), nombres_tramos(p)
    out = []
    for i in range(5):
        dia = d if i == t_act else (p["tramos"][i] if i < 4 else p["tramos"][3] + 30)
        dia = min(dia, len(curva) - 1)
        r = precio_regla(u, dia, curva[dia], p, stock)
        eq = r["equilibrio"]
        out.append(dict(tramo=i, nombre=nombres[i], dia=dia, precio=r["precio"], margen_usd=r["precio"] - eq,
                        margen_pct=(r["precio"] - eq) / eq if eq else None, caso=r["caso"], estado=ESTADOS_TRAMO[i][1],
                        color=ESTADOS_TRAMO[i][0], actual=i == t_act))
    return out


def proxima_revision(d, p, hoy=None):
    """Cuándo cambia la unidad de tramo (fecha y día). En el último tramo se revisa cada semana en el comité."""
    hoy = _fecha(hoy or date.today())
    t = tramo(d, p)
    if t == len(p["tramos"]):
        return dict(fecha=None, dia=None, cada_dias=p["dias_revision"])
    dia = p["tramos"][t] + 1
    return dict(fecha=(hoy + timedelta(days=dia - d)).isoformat(), dia=dia, cada_dias=p["dias_revision"])


def pasos_por_que(e, p):
    """Los 5 pasos de «Por qué este precio», en lenguaje simple, con los números de la evaluación e (salida de evaluar)."""
    aj, st = e["ajuste_stock"], e["stock"]
    pasos = [
        f"Con {e['dias']} días el carro está en el tramo {e['tramo_nombre']} ({e['estado'].lower()}), cuyo margen objetivo es "
        f"{pct_txt(e['margen_tramo'])}"
        + (f", menos {pct_txt(aj)} porque hay {st} unidades del mismo modelo" if aj else "")
        + f": precio por margen {usd(e['objetivo_margen'])} (el costo de {usd(e['costo_base'])} más ese margen; no sube con los días).",
        f"El mercado hoy es {usd(e['mercado'])} ({e['referencia']['fuente']}). En este tramo el tope es "
        f"{e['tope_tramo'] * 100:+.0f} % sobre esa referencia: {usd(e['tope_mercado'])}. ".replace("+0 %", "0 %")
        + ("Manda el tope de mercado: es menor que el precio por margen." if e["limita"] == "mercado"
           else "El precio por margen queda bajo el tope, así que manda el margen."),
        f"El piso de ganancia es el costo acumulado ({usd(e['costo_acumulado'])}) más {pct_txt(p['margen_minimo'])} de margen mínimo = "
        f"{usd(e['piso_ganancia'])}. El precio no baja de aquí mientras el mercado lo permita.",
        f"Caso de la regla: {e['caso_nombre']}. {e['frase_caso']}",
        f"Resultado: precio objetivo {usd(e['sugerido'])} (redondeado a USD 10); "
        + (f"sin margen de negociación: el piso y el tope de mercado dejan un solo precio ({usd(e['minimo'])})"
           if e["minimo"] == e["maximo"] else f"banda de negociación {usd(e['minimo'])} a {usd(e['maximo'])}")
        + f". Estado {e['estado'].lower()}.",
    ]
    return pasos


def texto_historico(h, linea, nombre):
    """Histórico del modelo (o de toda la línea si hay pocas ventas) con la comparación contra el promedio de la línea."""
    c = lambda v: f"{v:g}".replace(".", ",")
    if h and h["n"] >= 5:
        mas = h["p120"] > linea["p120"]
        return dict(modelo=True, n=h["n"], mediana=h["med"], promedio=h["prom"], p60=h["p60"], p120=h["p120"], mas_que_linea=mas,
                    texto=(f"Histórico de {nombre} ({h['n']} ventas de la línea 1001 en la base del caso): la unidad típica se vende en "
                           f"{h['med']} días (promedio {h['prom']}); el {c(h['p60'])} % sale antes de los 60 días y el {c(h['p120'])} % "
                           f"pasa de 120 (línea completa: {c(linea['p120'])} %). "
                           + ("Es un modelo que envejece más que el promedio: conviene actuar en el primer tramo." if mas
                              else "Rota mejor que el promedio de la línea.")))
    n_linea = f"{linea['n']:,}".replace(",", ".")
    return dict(modelo=False, n=linea["n"], mediana=linea["med"], promedio=linea["prom"], p60=linea["p60"], p120=linea["p120"],
                mas_que_linea=None,
                texto=(f"Histórico: {nombre} tiene pocas ventas en la base del caso; se usa el comportamiento de toda la línea 1001 "
                       f"({n_linea} ventas): mediana {linea['med']} días, promedio {linea['prom']}, {c(linea['p120'])} % pasa de 120."))


def comparacion_anuncio(publicado, sugerido, dias):
    """«1001carros.com lo publica a USD X. La regla sugiere USD Y para el día Z (± USD, %)»."""
    dif = sugerido - publicado
    porc = f"{abs(dif) / publicado * 100:.1f}".replace(".", ",")
    return (f"Comparación: 1001carros.com lo publica a {usd(publicado)}. La regla sugiere {usd(sugerido)} para el día {dias} "
            f"({'+' if dif >= 0 else '−'}{usd(abs(dif))}; {porc} % {'por encima' if dif >= 0 else 'por debajo'}).")


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
    por_sem = {"verde": 0, "amarillo": 0, "naranja": 0, "rojo": 0}
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


def beneficio_referencia(p):
    """Beneficio por unidad del business case (Entrega 1, sección 3.2): una unidad vendida entre los días 61 y 90 deja 9,6 % y
    después de 120 días 3,2 %; esos 6,4 % sobre el precio de referencia de USD 17.500 son USD 1.120 de margen recuperado.
    El capital evitado es USD 15.715 × 12 % ÷ 365 = USD 5,17 por día × 157 días (232 − 75) = USD 812. Total USD 1.932."""
    margen_pct = p["margen_61_90"] - p["margen_espera"]
    diario = round(p["costo_referencia"] * p["tasa_capital_anual"] / 365, 2)
    dias = p["dias_espera"] - p["base_dias_promedio"]
    margen_usd, capital = margen_pct * p["precio_referencia"], diario * dias
    return dict(margen_pct=margen_pct, margen_usd=margen_usd, costo_diario=diario, dias_evitados=dias, capital_evitado=capital,
                total=margen_usd + capital)


def escenarios_beneficio(p, porcentajes=(0.25, 0.5, 0.75)):
    """Tabla 3 de la Entrega 1: beneficio anual si dejan de superar 120 días el 25 %, 50 % o 75 % de las unidades."""
    b = beneficio_referencia(p)
    margen, capital = round(b["margen_usd"]), round(b["capital_evitado"])
    out = []
    for pc in porcentajes:
        n = int(p["ventas_mas_120_anuales"] * pc + 0.5)
        out.append(dict(pct=pc, unidades=n, margen=n * margen, capital=n * capital, total=n * (margen + capital)))
    return out


def texto_business_case(p):
    b, e = beneficio_referencia(p), {x["pct"]: x for x in escenarios_beneficio(p)}
    return (f"Entrega 1: {usd(round(b['margen_usd']) + round(b['capital_evitado']))} por unidad (margen recuperado {usd(b['margen_usd'])} "
            f"+ capital evitado {usd(b['capital_evitado'])}). Si dejan de superar 120 días el 25 % de las unidades ({e[0.25]['unidades']}): "
            f"{usd(e[0.25]['total'])} al año; el 50 % ({e[0.5]['unidades']}): {usd(e[0.5]['total'])}.")


def beneficio_venta(u, p):
    """Beneficio de una unidad realmente vendida antes del límite de antigüedad (tramos[3], 120 días), con la misma estructura
    del business case de la Entrega 1 (ver beneficio_referencia):
        margen recuperado = (precio de venta − costo de compra y reacondicionamiento) − costo × margen que deja esperar (3,2 %)
        capital evitado   = costo diario × (días de espera − días en piso)          (232 días en la Entrega 1)
        beneficio         = margen recuperado + capital evitado
    Con el carro de referencia (USD 15.715, día 75) el capital evitado es 5,17 × (232 − 75) = USD 812; el estándar de la
    Entrega 1 (USD 1.120 + USD 812 = USD 1.932 por unidad) está en beneficio_referencia.
    Las vendidas pasado el límite no suman. Devuelve None si no cuenta."""
    d = dias_en_piso(u)
    if d > p["tramos"][3] or u.get("precio_venta") is None:
        return None
    base = _base_costo(u)
    margen = (u["precio_venta"] - base) - base * p["margen_espera"]
    evitado = max(p["dias_espera"] - d, 0) * costo_diario(u, p)
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


def _meta(clave, nombre, formato, valor, base, p, k28, k29, menos_es_mejor, detalle, **extra):
    """Tarjeta de un objetivo: valor actual, línea base, meta 2028 (con la que se mide el avance) y meta 2029."""
    m28, m29 = p[k28], p[k29]
    a = _avance(valor, base, m28, menos_es_mejor)
    return dict(clave=clave, nombre=nombre, formato=formato, valor=valor, base=base, meta=m28, meta2029=m29,
                avance=a, estado=estado_avance(a), menos_es_mejor=menos_es_mejor, detalle=detalle, **extra)


def objetivos(en_piso, vendidas, cambios, p, hoy=None, ventana=VENTANA_OBJETIVOS):
    """Las cuatro metas del business case. en_piso: [{'u','e'}]; vendidas: unidades vendidas (cualquier fecha);
    cambios: cambios de precio de la ventana [{'precio_nuevo','precio_sugerido','precio_minimo','precio_maximo','aprobado'}].
    Cada tarjeta trae línea base, meta 2028 y meta 2029; el avance se mide contra la meta 2028."""
    hoy = _fecha(hoy or date.today())
    desde = hoy - timedelta(days=ventana)
    recientes = [u for u in vendidas if u.get("fecha_venta") and _fecha(u["fecha_venta"]) >= desde]
    n_piso = len(en_piso)
    out = []

    d_ven = [dias_en_piso(u) for u in recientes]
    d_piso = [f["e"]["dias"] for f in en_piso]
    v = (sum(d_ven) / len(d_ven)) if d_ven else None
    out.append(_meta("dias", "Días promedio en inventario", "dias", v, p["base_dias_promedio"], p, "meta_dias_2028", "meta_dias_2029", True,
                     (f"{len(d_ven)} vendidas en los últimos {ventana} días" if d_ven else f"Sin ventas en los últimos {ventana} días")
                     + (f" · en inventario hoy: {sum(d_piso) / n_piso:.0f} d" if n_piso else ""), meta_empresa=p["meta_dias_empresa"]))

    viejas = sum(x > p["tramos"][3] for x in d_piso)
    v = (viejas / n_piso) if n_piso else None
    out.append(_meta("mas120", f"Unidades con más de {p['tramos'][3]} días", "pct", v, p["base_pct_mas_120"], p,
                     "meta_pct_mas_120_2028", "meta_pct_mas_120_2029", True, f"{viejas} de {n_piso} unidades en inventario"))

    dentro = sum(1 for c in cambios if c.get("precio_sugerido") and
                 (not es_excepcion(c, p["tolerancia_excepcion"]) or c.get("aprobado") == 1))
    v = (dentro / len(cambios)) if cambios else None
    out.append(_meta("regla", "Cambios de precio dentro de la regla", "pct", v, None, p, "meta_pct_en_regla_2028", "meta_pct_en_regla_2029",
                     False, (f"{dentro} de {len(cambios)} en los últimos {ventana} días (dentro de la banda mínimo–máximo "
                             f"o con excepción aprobada)") if cambios else f"Sin cambios de precio en los últimos {ventana} días"))

    ben = [b for b in (beneficio_venta(u, p) for u in recientes) if b]
    periodo = sum(b["total"] for b in ben)
    anual = periodo * 365 / ventana
    out.append(_meta("beneficio", "Beneficio acumulado (margen + capital)", "usd", anual if ben else None, None, p,
                     "meta_beneficio_2028", "meta_beneficio_2029", False,
                     (f"{usd(periodo)} en {ventana} días ({len(ben)} ventas antes de {p['tramos'][3]} d) llevados a un año"
                      if ben else f"Sin ventas antes de {p['tramos'][3]} días en los últimos {ventana} días"),
                     periodo=periodo, margen=sum(b["margen"] for b in ben), capital_evitado=sum(b["capital_evitado"] for b in ben),
                     nota=texto_business_case(p)))
    return out


# ----------------------------------------------------------------------------- pruebas con usuarios (validación)
PERFILES = ["Asesor de concesionario", "Revendedor de usados", "Vendedor particular", "Dueño o administrador de negocio",
            "Evalúa precios o márgenes", "Otro"]
VENDIBLE = dict(si="Sí", ajuste="Sí, con ajuste", no="No")
DISPOSITIVOS = ["Celular", "Computadora"]
HIPOTESIS = [
    dict(clave="H1", texto="La regla da precios que los evaluadores consideran vendibles en 30 días en al menos 8 de cada 10 carros "
                           "probados (sí o sí con ajuste).", meta=0.8),
    dict(clave="H2", texto="Un asesor obtiene el precio sugerido en menos de 60 segundos y sin capacitación (4 de cada 5).", meta=0.8),
    dict(clave="H3", texto="El semáforo lleva al comité el 100 % de las unidades antes del día 91.", meta=1.0),
]


def resumen_hipotesis(pruebas, h3):
    """Calcula si se cumplen H1, H2 y H3.
    pruebas: lista de dict con 'vendible' (si / ajuste / no) y 'segundos'.
    h3: {'aplica': unidades que ya pasaron el día 90, 'pasaron': de ellas, las que tuvieron una revisión antes del día 91}."""
    h1 = [x for x in pruebas if x.get("vendible") in VENDIBLE]
    h2 = [x for x in pruebas if x.get("segundos") is not None]
    datos = {
        "H1": (sum(x["vendible"] in ("si", "ajuste") for x in h1), len(h1), "carros probados"),
        "H2": (sum(x["segundos"] < 60 for x in h2), len(h2), "pruebas con tiempo medido"),
        "H3": (h3.get("pasaron", 0), h3.get("aplica", 0), "unidades que ya pasaron el día 90"),
    }
    out = []
    for h in HIPOTESIS:
        ok_n, n, que = datos[h["clave"]]
        v = (ok_n / n) if n else None
        out.append(dict(**h, cumplen=ok_n, n=n, valor=v, que=que,
                        estado=None if v is None else "cumple" if v >= h["meta"] - 1e-9 else "no_cumple"))
    return out


def pasaron_por_comite(unidades, cambios, limite=None, hoy=None):
    """H3: de las unidades que ya pasaron el día 90 (en inventario o vendidas), cuántas tuvieron una revisión de precio con la
    regla (comité) hasta el día 91. unidades: dicts con id, fecha_ingreso, fecha_venta; cambios: filas de precios con
    unidad_id y fecha."""
    limite = limite or 91
    aplica = [u for u in unidades if dias_en_piso(u, hoy) > limite - 1]
    revisadas = set()
    for c in cambios:
        revisadas.add((c["unidad_id"], _fecha(c["fecha"])))
    por_unidad = {}
    for uid, f in revisadas:
        por_unidad.setdefault(uid, []).append(f)
    pasaron = [u for u in aplica if any((f - _fecha(u["fecha_ingreso"])).days <= limite for f in por_unidad.get(u["id"], []))]
    return dict(aplica=len(aplica), pasaron=len(pasaron))

