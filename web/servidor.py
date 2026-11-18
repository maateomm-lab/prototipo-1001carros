#!/usr/bin/env python3
"""
PRICING DINÁMICO 1001 · INVENTARIO (tesis)

Aplicación para los empleados: inventario de unidades con precio sugerido por día en piso, tablero de objetivos y
pruebas con usuarios. Usa el modelo XGBoost de ../xgboost/ como apoyo. Usuarios con contraseña (rol asesor o admin).
La calculadora de precio de toma (cotizador) ya no aparece en la página (v4); sus rutas y datos se conservan.
No necesita instalar nada nuevo: usa el servidor web y la base SQLite que ya trae Python.

Uso
  python servidor.py                  -> solo esta computadora: http://localhost:8000
  python servidor.py --host 0.0.0.0   -> también las demás computadoras de la oficina (muestra la dirección)

API (todas piden sesión salvo sesion/setup/login)
  GET  /api/sesion                 usuario actual y si falta crear el administrador
  POST /api/setup | login | logout
  GET  /api/catalogo               marcas, modelos, versiones, opciones y métricas del modelo
  POST /api/cotizar                datos del auto -> valor, rangos, curvas, efectos y carros comparables
  GET  /api/cotizaciones           historial (filtros: texto, estado, asesor)
  POST /api/cotizaciones           guardar una cotización
  GET/POST /api/cotizaciones/<id>  ver / cambiar estado, oferta final, cliente, notas
  GET  /api/resumen?dias=30        indicadores para gerencia
  GET/POST /api/usuarios[/<u>]     administrar empleados (solo admin)
  POST /api/yo/clave               cambiar mi contraseña
  GET/POST /api/inventario         lista con cálculos del día (filtros: estado, linea, agencia, semaforo, texto) / crear unidad
  GET/POST /api/inventario/<id>    detalle (curvas, costo, confianza, comparables, historiales) / editar, cambiar estado o vender
  POST /api/inventario/<id>/precio aplicar precio (sugerido, otro con motivo, o mantener con motivo)
  GET  /api/tablero                Tablero de objetivos: metas, decisiones de la semana y dónde está el dinero
  POST /api/precios/<id>/aprobar   aprobar o rechazar una excepción de precio (solo admin)
  GET/POST /api/parametros         parámetros del precio dinámico (guardar: solo admin)
"""
import argparse
import json
import os
import re
import socket
import sys
import threading
import time
from datetime import date, datetime, timedelta
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import joblib
import numpy as np
import pandas as pd

CARPETA = Path(__file__).resolve().parent
sys.path.insert(0, str(CARPETA.parent / "xgboost"))
import pricing_ml as P  # noqa: E402
import base_datos as BD  # noqa: E402
import inventario as INV  # noqa: E402
import datos_caso as CASO  # noqa: E402

STATIC = CARPETA / "static"
BD.crear_tablas()
CAMPOS = ["subtipo", "transmision", "combustible", "traccion", "ciudad", "provincia_placa", "vendedor_tipo",
          "climatizacion", "tapizado", "direccion", "vidrios"]

print("Cargando modelo...")
ART = joblib.load(P.ARTEFACTO)
if "catalogo" not in ART:
    sys.exit("El modelo guardado es de la versión anterior. Vuelve a entrenar:  python pricing_ml.py entrenar")
print("Cargando avisos para comparables...")
AVISOS = P.limpiar_usados(P.USADOS_DEF)[["marca", "familia", "version", "titulo", "anio", "km", "precio", "ciudad", "url"]]
N_FAMILIA = AVISOS.familia.value_counts().to_dict()
LOCK = threading.Lock()     # un solo hilo usa XGBoost a la vez
MAPA_FAMILIAS = CASO.mapa_familias(ART, N_FAMILIA)     # texto de familia del caso -> (marca, familia) del catálogo
VERSION = "v4 · 17-nov-2026"                           # versión del prototipo (se guarda en cada prueba con usuarios)


# ----------------------------------------------------------------------------- catálogo
def armar_catalogo():
    marcas = {}
    for marca, fams in ART["catalogo"].items():
        lista = []
        for fam, vers in fams.items():
            lista.append(dict(id=fam, nombre=P.nombre_familia(fam), n=int(N_FAMILIA.get(fam, 0)),
                              versiones=[dict(id=v, nombre=v.upper(), modelo=t) for v, t in sorted(vers.items())
                                         if v != "base"]))
        lista.sort(key=lambda f: (-f["n"], f["nombre"]))
        marcas[marca] = dict(n=sum(f["n"] for f in lista), modelos=lista)
    m = ART["metricas"]
    return dict(marcas=marcas, valores=ART["valores"], margen=ART["margen"], anio_ref=P.ANIO_REF,
                limite_confiable=P.LIMITE_CONFIABLE, n_avisos=ART["n_entrenamiento"], rangos=ART["rangos"],
                metricas={k: m[k] for k in ["afinado", "bajo_60k", "sobre_60k", "con_pn", "sin_pn"]})


CATALOGO = armar_catalogo()


# ----------------------------------------------------------------------------- predicción en lote (curvas)
def lote(autos):
    """Igual que pricing_ml.predecir pero para muchas filas a la vez (solo valor y rango probable)."""
    filas = []
    for a in autos:
        edad = max(P.ANIO_REF - int(a["anio"]), 0)
        km, pn = a.get("km"), a.get("pn_con_iva")
        filas.append(dict(marca=a["marca"], familia=a["familia"], version=a.get("version"), modelo=a.get("modelo"),
                          **{c: a.get(c) for c in CAMPOS}, edad=edad,
                          km=km if km is not None else np.nan,
                          km_anio=(km / max(edad, 1)) if km is not None else np.nan,
                          cilindraje=a.get("cilindraje") or np.nan,
                          pn_sin_iva=(pn / P.IVA) if pn else np.nan))
    X = P.matriz(pd.DataFrame(filas), ART["cats"])
    mu = ART["modelo"].predict(X)
    q50 = ART["q50"] * P.sigma(ART["dificultad"], X)
    return pd.DataFrame(dict(mercado=np.exp(mu), bajo50=np.exp(mu - q50), alto50=np.exp(mu + q50)))


def curvas(auto):
    km = auto.get("km") or 0
    paso = 10_000
    km_max = max(250_000, int(km * 1.8 / paso + 1) * paso)
    kms = list(range(0, km_max + 1, paso))
    ck = lote([{**auto, "km": float(k)} for k in kms]).assign(km=kms)
    ck = P._suavizar_decreciente(ck, "km", ["mercado", "bajo50", "alto50"])

    anio = int(auto["anio"])
    edad = max(P.ANIO_REF - anio, 0)
    ritmo = (km / edad) if (km and edad >= 1) else 14_500
    t = list(range(7))
    ks = [(km or edad * ritmo) + i * ritmo for i in t]
    ca = lote([{**auto, "anio": anio - i, "km": float(k)} for i, k in zip(t, ks)]).assign(t=t, km=ks)
    ca = P._suavizar_decreciente(ca, "t", ["mercado", "bajo50", "alto50"])
    return ck.to_dict("records"), ca.to_dict("records"), ritmo


def comparables(auto, mercado):
    g = AVISOS[AVISOS.familia == auto["familia"]]
    g = g[(g.anio - auto["anio"]).abs() <= 4]
    if g.empty:
        return [], 0
    dist = (g.anio - auto["anio"]).abs() + (g.km.fillna(g.km.median()) - (auto.get("km") or 0)).abs() / 40_000
    if auto.get("version"):
        dist = dist + (g.version != auto["version"]) * .5
    g = g.assign(d=dist).sort_values("d").head(60)
    out = [dict(titulo=r.titulo, anio=int(r.anio), km=None if pd.isna(r.km) else float(r.km), precio=float(r.precio),
                ciudad=None if pd.isna(r.ciudad) else r.ciudad, url=r.url,
                dif=float(r.precio / mercado - 1)) for r in g.itertuples()]
    return out, len(g)


def confianza(r, n):
    ancho = (r["alto50"] / r["mercado"] - 1) * 100
    if ancho <= 6 and n >= 30 and not r["fuera_de_rango"]:
        nivel = "alta"
    elif ancho <= 12 and n >= 10 and not r["fuera_de_rango"]:
        nivel = "media"
    else:
        nivel = "baja"
    return dict(nivel=nivel, ancho=ancho, n_modelo=n)


def cotizar(q):
    marca, familia = q["marca"], q["familia"]
    version = q.get("version") or None
    modelo = ART["catalogo"].get(marca, {}).get(familia, {}).get(version) if version else None
    auto = dict(marca=marca, familia=familia, version=version, modelo=modelo, anio=int(q["anio"]),
                km=float(q["km"]) if q.get("km") is not None else None,
                cilindraje=float(q["cilindraje"]) if q.get("cilindraje") else None,
                **{c: (q.get(c) or None) for c in CAMPOS},
                pn_con_iva=float(q["pn_con_iva"]) if q.get("pn_con_iva") else None)
    with LOCK:
        r = P.predecir(ART, margen=float(q.get("margen") or ART["margen"]), **auto)
        auto["pn_con_iva"] = r["pn_con_iva"]
        ck, ca, ritmo = curvas(auto)
    comps, _ = comparables(auto, r["mercado"])
    n = int(N_FAMILIA.get(familia, 0))
    efectos = sorted(({"factor": k, "efecto": v} for k, v in r["efectos"].items()), key=lambda e: -abs(e["efecto"]))
    return dict(resultado={k: r[k] for k in ["mercado", "bajo", "alto", "bajo50", "alto50", "margen", "toma",
                                              "fuera_de_rango", "pn_con_iva", "base"]},
                pn_detectado=bool(r["pn_con_iva"]) and not q.get("pn_con_iva"),
                confianza=confianza(r, n), efectos=efectos, curva_km=ck, curva_anios=ca, ritmo_km=ritmo,
                comparables=comps)


# ----------------------------------------------------------------------------- inventario y precio dinámico
_CURVAS = {}      # (unidad, día) -> curva de mercado; el mercado de una unidad solo cambia cuando cambia la fecha


def parametros():
    guardados = BD.parametros_guardados()
    p = INV.validar_parametros(guardados)
    if guardados and "costos_adicionales" not in guardados:     # migración v4: seguro, patio y lavado vuelven a 0 (Entrega 1)
        BD.guardar_parametros("migración v4", p)
    return p


def curva_unidad(u, hasta):
    clave = (u["id"], u["anio"], u["km"], u["familia"], u["version"], u["pn_con_iva"], u.get("mercado_manual"),
             u["fecha_ingreso"], hasta, date.today())
    if clave not in _CURVAS:
        if len(_CURVAS) > 500:
            _CURVAS.clear()
        with LOCK:
            _CURVAS[clave] = INV.curva_mercado(ART, u, hasta)
    return _CURVAS[clave]


def confianza_unidad(u, fila):
    """Confianza del valor de mercado de la unidad, con la misma regla del cotizador (confianza()): se mide sobre
    el valor del MODELO; una referencia manual no cambia el nivel, solo lo cubre."""
    n = int(N_FAMILIA.get(u["familia"], 0))
    r = dict(mercado=fila["modelo"], alto50=fila["modelo_alto50"], fuera_de_rango=bool(fila["modelo"] > P.LIMITE_CONFIABLE))
    c = confianza(r, n)
    manual = u.get("mercado_manual") is not None
    n_anio = int(((AVISOS.familia == u["familia"]) & (AVISOS.anio == u["anio"])).sum())
    out = {**c, **INV.explicar_confianza(c["nivel"], c["ancho"], n, r["fuera_de_rango"], bool(u.get("pn_con_iva")),
                                         manual, P.LIMITE_CONFIABLE, n_anio, u["anio"]), "referencia_manual": manual,
           "limite": P.LIMITE_CONFIABLE, "n_anio": n_anio}
    ref = INV.referencia_unidad(u)
    if ref["tipo"] == "apendice":       # con referencia del Apéndice E la confianza sale de cuántos anuncios la respaldan
        out.update(nivel=ref["nivel"], texto=INV.texto_confianza_apendice(ref), motivos=[], n_apendice=ref["n"])
    return out


def stock_familias(unidades=None):
    """Unidades en piso (o reservadas) por familia: la regla baja el margen objetivo cuando hay varias iguales."""
    n = {}
    for x in (unidades if unidades is not None else BD.listar_unidades()):
        if x["estado"] in ("En piso", "Reservada"):
            n[x["familia"]] = n.get(x["familia"], 0) + 1
    return n


def evaluar_unidad(u, p, hoy=None, stock=None):
    """Unidad + cálculos del día. Las ya vendidas solo traen la utilidad real.
    stock: resultado de stock_familias() cuando se evalúan muchas unidades (para no consultar la base cada vez)."""
    if u["estado"] in ("Vendida", "Liquidada"):
        return {**u, **INV.utilidad_real(u, p), "semaforo": None}
    n_fam = max((stock if stock is not None else stock_familias()).get(u["familia"], 1), 1)
    cu = curva_unidad(u, max(INV.DIAS_CURVA, INV.dias_en_piso(u, hoy) + 60))
    fila = cu[min(INV.dias_en_piso(u, hoy), len(cu) - 1)]
    auto = dict(marca=u["marca"], familia=u["familia"], version=u["version"], anio=u["anio"], km=u["km"])
    _, n = comparables(auto, fila["mercado"])
    return {**u, **INV.evaluar(u, cu, p, hoy, n_comparables=n, conf=confianza_unidad(u, fila), stock=n_fam,
                               ref=INV.referencia_unidad(u))}


def nombre_unidad(q):
    ver = q.get("version")
    return f"{q['marca']} {P.nombre_familia(q['familia'])}{' ' + ver.upper() if ver and ver != 'base' else ''} {q['anio']}"


def valor_modelo_hoy(u):
    """Valor de mercado que daría el modelo HOY para la unidad, sin la referencia manual (para compararlo con ella)."""
    num = lambda v: float(v) if v not in (None, "") else None          # el formulario manda los números como texto
    u = {**u, "mercado_manual": None, "anio": int(u["anio"]), "km": num(u.get("km")), "cilindraje": num(u.get("cilindraje")),
         "pn_con_iva": num(u.get("pn_con_iva")), "fecha_ingreso": (u.get("fecha_ingreso") or date.today().isoformat())[:10],
         "fecha_venta": None}
    d = INV.dias_en_piso(u)
    with LOCK:
        cu = INV.curva_mercado(ART, u, max(d, 1))
    return cu[min(d, len(cu) - 1)]["modelo"]       # lo que dice el modelo, no la referencia del Apéndice E


def crear_unidad(yo, q):
    q = dict(q)
    pn_usuario = bool(q.get("pn_con_iva"))
    cot = q.get("cotizacion_id")
    if cot:                                           # desde una cotización comprada: precarga el auto
        c = BD.obtener_cotizacion(int(cot), yo)
        if c["estado"] != "Comprada":
            raise ValueError("Solo se pasan a inventario las cotizaciones en estado Comprada")
        if any(x["cotizacion_id"] == c["id"] for x in BD.listar_unidades()):
            raise ValueError("Esta cotización ya está en inventario")
        e = c["datos"]["entrada"]
        q = {**{k: e.get(k) for k in ["marca", "familia", "version", "anio", "km", "cilindraje", "pn_con_iva", *INV.CAMPOS_MODELO]},
             "costo_compra": c["oferta_final"], "placa": c["placa"], "color": c["color"], "vehiculo": c["vehiculo"], **q}
        q["pn_con_iva"] = q.get("pn_con_iva") or c["datos"]["resultado"].get("pn_con_iva")
    fams = ART["catalogo"].get(q.get("marca"), {})
    if q.get("familia") not in fams:
        raise ValueError("Elige una marca y un modelo de la lista")
    q["version"] = q.get("version") or None
    q["modelo"] = fams[q["familia"]].get(q["version"]) if q["version"] else None
    if not q.get("vehiculo"):
        q["vehiculo"] = nombre_unidad(q)
    q["pn_origen"] = "manual" if pn_usuario else ("cotización" if q.get("pn_con_iva") else None)
    if not q.get("pn_con_iva"):
        txt = q["modelo"] or f"{P.nombre_familia(q['familia'])} {'' if q['version'] in (None, 'base') else q['version']}"
        q["pn_con_iva"] = P.buscar_pn(q["marca"], f"{q['marca']} {txt}", q.get("cilindraje"), q.get("transmision"),
                                      q.get("traccion"), ART["nuevos"])
        q["pn_origen"] = "detectado" if q["pn_con_iva"] else None
    if q.get("mercado_manual") not in (None, ""):          # guarda también lo que decía el modelo ese día
        q["_valor_modelo"] = valor_modelo_hoy(q)
    return BD.crear_unidad(yo["usuario"], q)


def editar_unidad(yo, uid, q):
    """Cambios de estado, venta y datos de la unidad. Si fija o cambia la referencia manual guarda el valor del modelo."""
    q = dict(q)
    if q.get("mercado_manual") not in (None, ""):
        u = BD.obtener_unidad(uid)
        if "pn_con_iva" in q:
            u["pn_con_iva"] = q["pn_con_iva"] or None
        q["_valor_modelo"] = valor_modelo_hoy(u)
    BD.actualizar_unidad(uid, q, usuario=yo["usuario"])


def anuncios_1001():
    """Los 100 anuncios reales de 1001carros.com del 7-oct-2026 con su marca y familia del catálogo del modelo, y el
    costo propuesto (precio publicado ÷ 1,12)."""
    out = []
    for i, x in enumerate(CASO.anuncios_1001()):
        mf = CASO.buscar(MAPA_FAMILIAS, x["f"])
        if mf:
            out.append(dict(idx=i, marca=mf[0], familia=mf[1], modelo=x["m"], anio=x["a"], km=x["k"], precio=x["p"],
                            ciudad=x["c"], costo=round(x["p"] / CASO.MARGEN_PUBLICADO, -1)))
    return out


def historico_modelo(familia):
    """Frase con el histórico del modelo en la base del caso (días en inventario), o None si no hay."""
    h = CASO.hist_de_familia(familia)
    nombre = P.nombre_familia(familia)
    if h and h["n"] >= 5:
        return dict(**h, nombre=nombre, texto=f"En la base del caso, {nombre} se vendió con mediana de {h['med']} días "
                    f"({h['n']} ventas); {str(h['p120']).replace('.', ',')} % pasó de 120 días y "
                    f"{str(h['p60']).replace('.', ',')} % se vendió en 60 días o menos.")
    return None


def detalle_unidad(uid, p):
    u = BD.obtener_unidad(uid)
    e = evaluar_unidad(u, p)
    out = dict(historico_modelo=historico_modelo(u["familia"]),unidad=u, evaluacion=e, parametros=p, historial=BD.historial_precios(uid),
               referencias=BD.historial_referencias(uid), tramos=INV.nombres_tramos(p), limites=p["tramos"],
               desglose=INV.desglose_costo(u, p, e["dias"]))
    if u["estado"] not in ("Vendida", "Liquidada"):
        d = e["dias"]
        cu = curva_unidad(u, max(INV.DIAS_CURVA, d + 60))
        de = e["dia_equilibrio"]
        hasta = min(len(cu) - 1, max(d + 60, (de + 30) if de is not None else 0, 90))     # hoy + 60 días o el equilibrio + 30
        out["curvas"] = INV.serie(u, cu, p, hasta, stock=e["stock"])
        comps, n = comparables(dict(familia=u["familia"], anio=u["anio"], km=u["km"], version=u["version"]), e["mercado"])
        out["comparables"], out["n_comparables"] = comps[:15], n
    return out


def lista_inventario(q):
    p = parametros()
    filas, stock = [], stock_familias()
    for u in BD.listar_unidades(q):
        e = evaluar_unidad(u, p, stock=stock)
        if q.get("semaforo") and e["semaforo"] != q["semaforo"]:
            continue
        filas.append(e)
    return dict(unidades=filas, tramos=INV.nombres_tramos(p),
                agencias=sorted({x["agencia"] for x in BD.listar_unidades() if x["agencia"]}))


def decisiones_semana(en_piso, p, hoy=None):
    """Lista de trabajo de la reunión semanal: solo las unidades que necesitan una decisión, de la más urgente a la
    menos urgente (rojo, revisión vencida, confianza baja sin referencia manual, fuera de la banda de mercado)."""
    hoy = hoy or date.today()
    filas = []
    for f in en_piso:
        u, e = f["u"], f["e"]
        motivos = []                                           # (prioridad, texto)
        if e["semaforo"] == "rojo":
            razones = (["pérdida inevitable: el costo acumulado supera al mercado"] if e["caso"] == "perdida_inevitable" else []) + \
                      ([f"más de {p['tramos'][3]} días en piso"] if e["dias"] > p["tramos"][3] else []) + \
                      (["publicado bajo el costo acumulado"] if u["precio_publicado"] < e["costo_acumulado"] else [])
            motivos.append((0, "Crítico: " + " y ".join(razones)))
        elif e["semaforo"] == "naranja":
            motivos.append((1, f"Alerta: va al comité antes de cruzar los {p['tramos'][3]} días"))
        if e["revision_vencida"]:
            sin = (hoy - date.fromisoformat((u.get("ultima_revision") or u["fecha_ingreso"])[:10])).days
            motivos.append((2, f"Revisión vencida ({sin} días sin revisar)"))
        if e["aviso_confianza"]:
            motivos.append((3, "Confianza baja sin referencia manual"))
        if not e["en_banda"]:
            motivos.append((4, "Precio publicado fuera de la banda de negociación"))
        if motivos:
            filas.append({**{k: u[k] for k in ["id", "vehiculo", "marca", "familia", "anio", "linea", "agencia", "placa",
                                               "precio_publicado", "mercado_manual"]},
                          **{k: e[k] for k in ["dias", "semaforo", "mercado", "sugerido", "recomendacion", "texto",
                                               "costo_acumulado", "tramo_nombre", "caso", "caso_nombre", "estado",
                                               "accion_comercial", "minimo", "maximo"]},
                          "confianza": e["confianza"]["nivel"], "prioridad": min(m[0] for m in motivos),
                          "motivos": [m[1] for m in sorted(motivos)], "igual": e["recomendacion"] == "Mantener"})
    filas.sort(key=lambda r: (r["prioridad"], -r["dias"]))
    return filas


def tablero():
    p = parametros()
    todas = BD.listar_unidades()
    stock = stock_familias(todas)
    en_piso = [dict(u=u, e=evaluar_unidad(u, p, stock=stock)) for u in todas if u["estado"] in ("En piso", "Reservada")]
    vendidas = [u for u in todas if u["estado"] in ("Vendida", "Liquidada")]
    decisiones = decisiones_semana(en_piso, p)
    hace7 = (datetime.now() - timedelta(days=7)).isoformat(timespec="seconds")
    # excepciones de la semana + las que siguen sin aprobar (hasta 90 días atrás)
    excepciones = [r for r in BD.excepciones_precio(p["tolerancia_excepcion"], INV.VENTANA_OBJETIVOS)
                   if r["fecha"] >= hace7 or r["aprobado"] is None]
    dinero = INV.indicadores_comite(en_piso, p)
    return dict(objetivos=INV.objetivos(en_piso, vendidas, BD.cambios_precio(INV.VENTANA_OBJETIVOS), p),
                ventana=INV.VENTANA_OBJETIVOS, decisiones=decisiones, semaforos=dinero["por_semaforo"],
                dinero=dinero, tramos=INV.nombres_tramos(p), limite_antiguas=p["tramos"][3],
                excepciones=excepciones, tolerancia_excepcion=p["tolerancia_excepcion"])


def pruebas_con_usuarios():
    """Pruebas registradas + resumen de H1, H2 y H3 (H3 se calcula con el inventario: unidades que pasaron el día 90
    y si tuvieron una revisión de precio con la regla hasta el día 91)."""
    pr = BD.listar_pruebas()
    h3 = INV.pasaron_por_comite(BD.listar_unidades(), BD.cambios_precio(3650), parametros()["tramos"][2] + 1)
    return dict(pruebas=pr, resumen=INV.resumen_hipotesis(pr, h3), h3=h3, perfiles=INV.PERFILES,
                vendible=INV.VENDIBLE, dispositivos=INV.DISPOSITIVOS, version=VERSION)


def csv_pruebas():
    """Las pruebas en CSV (separador ; y coma decimal, para abrirlo directo en Excel en español)."""
    cols = [("fecha", "Fecha"), ("participante", "Participante"), ("perfil", "Perfil"), ("ciudad", "Ciudad"),
            ("version", "Versión"), ("carro", "Carro probado"), ("precio_sugerido", "Precio sugerido"),
            ("vendible", "¿Vendible en 30 días?"), ("precio_pondria", "Precio que pondría"), ("segundos", "Segundos"),
            ("dispositivo", "Dispositivo"), ("utilidad", "Utilidad (1-5)"), ("facilidad", "Facilidad (1-5)"),
            ("comentarios", "Comentarios"), ("nombre_usuario", "Registró")]
    def celda(k, v):
        if v is None:
            return ""
        if k == "vendible":
            v = INV.VENDIBLE.get(v, v)
        if isinstance(v, float):
            v = (f"{v:.0f}" if v == int(v) else f"{v:.2f}").replace(".", ",")
        v = str(v)
        return '"' + v.replace('"', '""') + '"' if any(ch in v for ch in ';"\n') else v
    filas = [";".join(t for _, t in cols)] + [";".join(celda(k, p.get(k)) for k, _ in cols) for p in BD.listar_pruebas()]
    return "﻿" + "\r\n".join(filas) + "\r\n"


def aplicar_precio(yo, uid, q):
    p = parametros()
    u = BD.obtener_unidad(uid)
    if u["estado"] in ("Vendida", "Liquidada"):
        raise ValueError("La unidad ya fue vendida: no se puede cambiar su precio")
    e = evaluar_unidad(u, p)
    if q.get("mantener"):                                  # revisión sin cambio de precio: siempre con motivo
        if not (q.get("motivo") or "").strip():
            raise ValueError("Escribe el motivo para mantener el precio (queda registrado para el comité)")
        nuevo = u["precio_publicado"]
    elif q.get("aplicar_sugerido"):                        # dentro de la banda se confirma el precio actual, sin moverlo
        nuevo = u["precio_publicado"] if e["recomendacion"] == "Mantener" else e["sugerido"]
    else:
        nuevo = q.get("precio")
    BD.aplicar_precio(uid, yo["usuario"], nuevo, e["sugerido"], q.get("motivo"), p["tolerancia_excepcion"],
                      minimo=e["minimo"], maximo=e["maximo"], caso=e["caso"])


# ----------------------------------------------------------------------------- servidor
class NoAutorizado(Exception):
    pass


def solo_admin(yo):
    if yo["rol"] != "admin":
        raise PermissionError("Solo un administrador puede hacer esto")


class Manejador(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")     # el navegador siempre pide la versión nueva de la página
        super().end_headers()

    def _json(self, obj, code=200, cookie=None):
        cuerpo = json.dumps(obj, ensure_ascii=False, default=float).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        if cookie is not None:
            edad = 86400 * BD.DIAS_SESION if cookie else 0
            self.send_header("Set-Cookie", (f"sesion={cookie}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/; Max-Age={edad}" if os.environ.get("SPACE_ID") else f"sesion={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age={edad}"))
        self.end_headers()
        self.wfile.write(cuerpo)

    def _token(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c["sesion"].value if "sesion" in c else None

    def _yo(self):
        yo = BD.usuario_de(self._token())
        if not yo:
            raise NoAutorizado()
        return yo

    def _cuerpo(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _api(self, metodo):
        url = urlsplit(self.path)
        ruta, qs = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            # --- sin sesión
            if ruta == "/api/sesion" and metodo == "GET":
                return self._json(dict(usuario=BD.usuario_de(self._token()), setup=not BD.hay_usuarios()))
            if ruta == "/api/setup" and metodo == "POST":
                if BD.hay_usuarios():
                    raise PermissionError("El administrador ya fue creado")
                q = self._cuerpo()
                BD.crear_usuario(q.get("usuario"), q.get("nombre"), q.get("clave"), "admin")
                token, yo = BD.iniciar_sesion(q.get("usuario"), q.get("clave"))
                return self._json(dict(usuario=yo), cookie=token)
            if ruta == "/api/login" and metodo == "POST":
                q = self._cuerpo()
                token, yo = BD.iniciar_sesion(q.get("usuario"), q.get("clave"))
                if not token:
                    time.sleep(1)                                   # frena intentos de adivinar contraseñas
                    return self._json({"error": "Usuario o contraseña incorrectos"}, 400)
                return self._json(dict(usuario=yo), cookie=token)
            if ruta == "/api/logout" and metodo == "POST":
                BD.cerrar_sesion(self._token())
                return self._json({"ok": True}, cookie="")

            # --- con sesión
            yo = self._yo()
            if ruta == "/api/catalogo" and metodo == "GET":
                return self._json(CATALOGO)
            if ruta == "/api/cotizar" and metodo == "POST":
                return self._json(cotizar(self._cuerpo()))
            if ruta == "/api/cotizaciones" and metodo == "GET":
                return self._json(BD.listar_cotizaciones(yo, qs))
            if ruta == "/api/cotizaciones" and metodo == "POST":
                return self._json({"id": BD.guardar_cotizacion(yo["usuario"], self._cuerpo())})
            m = re.fullmatch(r"/api/cotizaciones/(\d+)", ruta)
            if m and metodo == "GET":
                return self._json(BD.obtener_cotizacion(int(m[1]), yo))
            if m and metodo == "POST":
                BD.actualizar_cotizacion(int(m[1]), yo, self._cuerpo())
                return self._json(BD.obtener_cotizacion(int(m[1]), yo))
            if ruta == "/api/resumen" and metodo == "GET":
                return self._json(BD.resumen(yo, int(qs.get("dias", 30))))
            if ruta == "/api/usuarios" and metodo == "GET":
                solo_admin(yo)
                return self._json(BD.listar_usuarios())
            if ruta == "/api/usuarios" and metodo == "POST":
                solo_admin(yo)
                q = self._cuerpo()
                return self._json(BD.crear_usuario(q.get("usuario"), q.get("nombre"), q.get("clave"), q.get("rol", "asesor")))
            m = re.fullmatch(r"/api/usuarios/([\w.\-]+)", ruta)
            if m and metodo == "POST":
                solo_admin(yo)
                q = self._cuerpo()
                if m[1] == yo["usuario"] and (q.get("activo") is False or q.get("rol") == "asesor"):
                    raise ValueError("No puedes quitarte el acceso de administrador a ti mismo")
                BD.modificar_usuario(m[1], clave=q.get("clave"), rol=q.get("rol"), activo=q.get("activo"))
                return self._json({"ok": True})
            if ruta == "/api/yo/clave" and metodo == "POST":
                q = self._cuerpo()
                if not BD.iniciar_sesion(yo["usuario"], q.get("actual"))[0]:
                    raise ValueError("La contraseña actual no es correcta")
                BD.modificar_usuario(yo["usuario"], clave=q.get("nueva"))
                return self._json({"ok": True}, cookie="")
            if ruta == "/api/inventario" and metodo == "GET":
                return self._json(lista_inventario(qs))
            if ruta == "/api/inventario" and metodo == "POST":
                uid = crear_unidad(yo, self._cuerpo())
                return self._json(detalle_unidad(uid, parametros()))
            m = re.fullmatch(r"/api/inventario/(\d+)", ruta)
            if m and metodo == "GET":
                return self._json(detalle_unidad(int(m[1]), parametros()))
            if m and metodo == "POST":
                editar_unidad(yo, int(m[1]), self._cuerpo())
                return self._json(detalle_unidad(int(m[1]), parametros()))
            m = re.fullmatch(r"/api/inventario/(\d+)/precio", ruta)
            if m and metodo == "POST":
                aplicar_precio(yo, int(m[1]), self._cuerpo())
                return self._json(detalle_unidad(int(m[1]), parametros()))
            if ruta == "/api/pruebas" and metodo == "GET":
                return self._json(pruebas_con_usuarios())
            if ruta == "/api/pruebas" and metodo == "POST":
                return self._json({"id": BD.crear_prueba(yo["usuario"], self._cuerpo())})
            m = re.fullmatch(r"/api/pruebas/(\d+)/borrar", ruta)
            if m and metodo == "POST":
                solo_admin(yo)
                BD.borrar_prueba(int(m[1]))
                return self._json({"ok": True})
            if ruta == "/api/pruebas.csv" and metodo == "GET":
                cuerpo = csv_pruebas().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="pruebas_prototipo_{date.today().isoformat()}.csv"')
                self.send_header("Content-Length", str(len(cuerpo)))
                self.end_headers()
                self.wfile.write(cuerpo)
                return
            if ruta == "/api/anuncios1001" and metodo == "GET":
                return self._json(anuncios_1001())
            if ruta in ("/api/tablero", "/api/comite") and metodo == "GET":
                return self._json(tablero())
            m = re.fullmatch(r"/api/precios/(\d+)/aprobar", ruta)
            if m and metodo == "POST":
                solo_admin(yo)
                BD.aprobar_excepcion(int(m[1]), yo["usuario"], bool(self._cuerpo().get("aprobar", True)))
                return self._json({"ok": True})
            if ruta == "/api/parametros" and metodo == "GET":
                return self._json(dict(parametros=parametros(), por_defecto=INV.PARAMS_DEF, tramos=INV.nombres_tramos(parametros()),
                                       info_costos=INV.COSTOS_INFO, param_de=INV.PARAM_DE,
                                       adicionales_ejemplo=INV.ADICIONALES_SENSIBILIDAD))
            if ruta == "/api/parametros" and metodo == "POST":
                solo_admin(yo)
                q = self._cuerpo()
                p = INV.validar_parametros(q.get("parametros"))
                if q.get("guardar", True):
                    BD.guardar_parametros(yo["usuario"], p)
                ejemplo = evaluar_unidad(BD.obtener_unidad(int(q["unidad_id"])), p) if q.get("unidad_id") else None
                return self._json(dict(parametros=p, tramos=INV.nombres_tramos(p), ejemplo=ejemplo))
            return self._json({"error": "ruta no encontrada"}, 404)
        except NoAutorizado:
            return self._json({"error": "Tu sesión terminó. Vuelve a ingresar."}, 401)
        except PermissionError as e:
            return self._json({"error": str(e)}, 403)
        except LookupError as e:
            return self._json({"error": str(e)}, 404)
        except Exception as e:  # el error se muestra en la página en vez de cortar la conexión
            msg = str(e) if isinstance(e, ValueError) else f"{type(e).__name__}: {e}"
            return self._json({"error": msg}, 400)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api("GET")
        return super().do_GET()

    def do_POST(self):
        return self._api("POST")

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def ip_local():
    """IP de esta computadora en la red de la oficina (para que los demás entren desde sus equipos)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--puerto", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 para que entren otras computadoras de la red")
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.puerto), Manejador)
    print(f"\nPricing dinámico 1001 · Inventario listo en  http://localhost:{a.puerto}   (Ctrl+C para cerrar)")
    if a.host == "0.0.0.0" and ip_local():
        print(f"Los demás empleados entran desde su computadora a:  http://{ip_local()}:{a.puerto}")
    if not BD.hay_usuarios():
        print("Primera vez: al abrir la página te pedirá crear el usuario administrador.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
