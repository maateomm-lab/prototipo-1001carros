#!/usr/bin/env python3
"""Crea el inventario de EJEMPLO con datos reales del caso (todo marcado como demo).

  python sembrar_demo.py            crea las unidades (si ya existen demos, no duplica)
  python sembrar_demo.py --borrar   quita solo las unidades demo (las reales no se tocan)

Qué trae:
  - Las 72 unidades reales de la línea 1001 de DATOS/insumos_v3 (familia, año, km, agencia, región y días reales en
    inventario; fecha de ingreso = hoy − días). Las que no existen en el catálogo del modelo se omiten y se informa cuántas.
    Los costos de la base vienen alterados y no se usan: el costo de compra se estima como la referencia de mercado del
    Apéndice E al ingreso (o el modelo, si la familia no está en la muestra) ÷ 1,114 (margen de ingreso de 10–12 % de la
    empresa; con la referencia 21.800 del Corolla 2023 da el costo de la Entrega 1). Precio publicado = costo × 1,12 ± 5 %
    (semilla fija), para que haya unidades dentro y fuera de la banda de negociación.
  - 4 unidades de CONFIANZA BAJA: dos Nissan Pathfinder 2023 y dos Cadillac Escalade 2022; de cada par, una sin referencia
    manual y otra con referencia manual y su fuente.
  - 11 unidades ya vendidas en los últimos 90 días (una pasó de 120 días y quedó liquidada), para los objetivos del tablero; se venden
    con la regla: costo × (1 + margen objetivo del tramo de venta) ± 3 % (como si el precio sugerido se hubiera aplicado).
  - Revisiones de precio dentro de la banda (una primera revisión antes del día 91 en la mayoría de las unidades viejas y
    cambios recientes en los últimos 60 días) y 4 excepciones con motivo: 2 aprobadas y 2 pendientes.
"""
import argparse
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import joblib

CARPETA = Path(__file__).resolve().parent
sys.path.insert(0, str(CARPETA.parent / "xgboost"))
import pricing_ml as P  # noqa: E402
import base_datos as BD  # noqa: E402
import inventario as INV  # noqa: E402
import datos_caso as CASO  # noqa: E402

AGENCIAS_EXTRA = ["Agencia Cb 4", "Agencia Cb 8", "Agencia Cb 2"]
FUENTE_REF = "comparables Patio Tuerca {}"
# unidades de confianza baja: (marca, texto de la familia, año, km, días en inventario, referencia manual o None)
CONFIANZA_BAJA = [("Nissan", "pathfinder", 2023, 14000, 38, None), ("Nissan", "pathfinder", 2023, 22000, 52, 38000),
                  ("Cadillac", "escalade", 2022, 31000, 27, None), ("Cadillac", "escalade", 2022, 26000, 61, 66000)]
# ventas de los últimos 90 días: (días en inventario, hace cuántos días se vendió)
VENTAS = [(31, 4), (36, 9), (44, 15), (49, 21), (55, 27), (62, 34), (70, 41), (78, 52), (91, 60), (108, 71), (134, 83)]


def buscar_familia(art, marca, texto):
    for fam in art["catalogo"].get(marca, {}):
        if fam.split(" ", 1)[-1].replace(" ", "") == texto.replace(" ", ""):
            return fam
    return None


def _auto(art, marca, fam, anio, km, ingreso):
    u = dict(marca=marca, familia=fam, version=None, modelo=None, anio=anio, km=km, pn_con_iva=None,
             fecha_ingreso=ingreso.isoformat())
    u["pn_con_iva"] = P.buscar_pn(marca, f"{marca} {P.nombre_familia(fam)}", None, None, None, art["nuevos"])
    return u


def _crear(art, azar, i, u, hoy, linea=None, ref=None, reacond=0, agencia=None, region=None):
    """Crea la unidad con costo de compra = mercado de ingreso ÷ 1,114 (o desde la referencia manual)."""
    base = ref or INV.curva_mercado(art, u, 1)[0]["mercado"]
    costo = round(base / CASO.MARGEN_INGRESO, -1)
    pub = round(costo * CASO.MARGEN_PUBLICADO * (1 + azar.uniform(-0.05, 0.05)), -1)
    txt = P.nombre_familia(u["familia"])
    extra = dict(mercado_manual=ref, fuente_mercado_manual=FUENTE_REF.format(hoy.strftime("%d-%m-%Y"))) if ref else {}
    return BD.crear_unidad("demo", dict(
        marca=u["marca"], familia=u["familia"], anio=u["anio"], km=u["km"], pn_con_iva=u["pn_con_iva"],
        pn_origen="detectado" if u["pn_con_iva"] else None, linea=linea or "1001",
        agencia=agencia or AGENCIAS_EXTRA[i % len(AGENCIAS_EXTRA)], region=region, fecha_ingreso=u["fecha_ingreso"],
        costo_compra=costo, reacondicionamiento=reacond, precio_publicado=pub, vehiculo=f"{u['marca']} {txt} {u['anio']}",
        placa=f"P{'ABCDEFGH'[i % 8]}{'XYZ'[i % 3]}-{1000 + i * 37}", **extra), demo=True)


def sembrar():
    BD.crear_tablas()
    if any(u["demo"] for u in BD.listar_unidades()):
        print("Ya hay unidades demo. Usa --borrar para quitarlas y volver a sembrar.")
        return
    art = joblib.load(P.ARTEFACTO)
    p = INV.validar_parametros(BD.parametros_guardados())
    azar = random.Random(7)
    hoy = date.today()
    conteos = P.limpiar_usados(P.USADOS_DEF).familia.value_counts().to_dict()
    mapa = CASO.mapa_familias(art, conteos)
    en_piso, vendidas, omitidas, i = [], 0, [], 0

    # 1. las 72 unidades reales de la línea 1001 (las que existen en el modelo)
    for x in CASO.inventario_caso():
        mf = CASO.buscar(mapa, x["f"])
        if not mf or not x.get("a"):
            omitidas.append(x["f"])
            continue
        marca, fam = mf
        u = _auto(art, marca, fam, int(x["a"]), float(x["k"]), hoy - timedelta(days=x["d"]))
        en_piso.append((_crear(art, azar, i, u, hoy, agencia=x["ag"], region=x["rg"]), x["d"]))
        i += 1

    # 2. confianza baja: sin referencia manual y con referencia manual
    for marca, texto, anio, km, d, ref in CONFIANZA_BAJA:
        fam = buscar_familia(art, marca, texto)
        if not fam:
            omitidas.append(f"{marca} {texto}")
            continue
        u = _auto(art, marca, fam, anio, km, hoy - timedelta(days=d))
        en_piso.append((_crear(art, azar, i, u, hoy, linea="Autos OK", ref=ref), d))
        i += 1
    n_piso = len(en_piso)

    # 3. ventas de los últimos 90 días (para los objetivos del tablero)
    comunes = [mf for mf in {CASO.buscar(mapa, x["f"]) for x in CASO.inventario_caso()} if mf]
    comunes.sort()
    for k, (d, hace) in enumerate(VENTAS):
        marca, fam = comunes[(k * 7) % len(comunes)]
        anio = azar.randint(2016, 2023)
        km = round(azar.uniform(9000, 17000) * max(hoy.year - anio, 1) / 1000) * 1000
        venta = hoy - timedelta(days=hace)
        u = _auto(art, marca, fam, anio, km, venta - timedelta(days=d))
        uid = _crear(art, azar, i, u, hoy, linea=("1001", "Autos OK")[k % 2])
        i += 1
        real = BD.obtener_unidad(uid)
        base = real["costo_compra"] + (real["reacondicionamiento"] or 0)
        precio = round(base * (1 + p["margenes"][INV.tramo(d, p)]) * azar.uniform(0.99, 1.03), -1)     # margen objetivo del tramo ± banda
        BD.actualizar_unidad(uid, dict(estado="Liquidada" if d > p["tramos"][3] else "Vendida", fecha_venta=venta.isoformat(),
                                       precio_venta=precio))
        vendidas += 1

    # --- ayudas para las revisiones de precio
    def stock():
        n = {}
        for x in BD.listar_unidades():
            if x["estado"] in ("En piso", "Reservada"):
                n[x["familia"]] = n.get(x["familia"], 0) + 1
        return n
    por_familia = stock()

    def evaluar(uid):
        u = BD.obtener_unidad(uid)
        d = INV.dias_en_piso(u)
        cu = INV.curva_mercado(art, u, max(INV.DIAS_CURVA, d + 60))
        return INV.evaluar(u, cu, p, stock=por_familia.get(u["familia"], 1))

    def fechar(dt):
        with BD.con() as c:
            c.execute("UPDATE precios_inventario SET fecha=? WHERE id=(SELECT MAX(id) FROM precios_inventario)",
                      (dt.isoformat(timespec="seconds"),))

    def dentro_de_la_banda(e):
        return float(INV._r10(azar.uniform(e["minimo"], e["maximo"])))

    # 4. revisiones dentro de la banda: una primera revisión antes del día 91 y cambios recientes
    for uid, d in en_piso:
        ingreso = hoy - timedelta(days=d)
        if d > 20 and azar.random() < 0.85:                       # primera revisión (el comité la ve antes del día 91)
            e = evaluar(uid)
            BD.aplicar_precio(uid, "demo", dentro_de_la_banda(e), e["sugerido"], None, p["tolerancia_excepcion"],
                              minimo=e["minimo"], maximo=e["maximo"], caso=e["caso"])
            fechar(datetime.combine(ingreso + timedelta(days=azar.randint(20, min(88, d))), datetime.min.time()) + timedelta(hours=10))
    for uid, d in en_piso[::2]:                                   # cambios recientes
        e = evaluar(uid)
        BD.aplicar_precio(uid, "demo", dentro_de_la_banda(e), e["sugerido"], None, p["tolerancia_excepcion"],
                          minimo=e["minimo"], maximo=e["maximo"], caso=e["caso"])
        fechar(datetime.now() - timedelta(days=azar.randint(1, min(d, 60))))

    # 5. excepciones con motivo (fuera de la banda): dos aprobadas y dos pendientes
    excepciones = [(en_piso[1][0], 1.07, "Cliente dispuesto a pagar más; unidad con pocos comparables", True),
                   (en_piso[4][0], 0.92, "Liquidar rápido por cierre de mes en la agencia", True),
                   (en_piso[7][0], 1.06, "Se espera un cliente que ya vio el carro y quiere cerrar a este precio", False),
                   (en_piso[10][0], 0.91, "Promoción de la agencia por feria de autos", False)]
    for uid, factor, motivo, aprobada in excepciones:
        e = evaluar(uid)
        nuevo = round((e["maximo"] if factor > 1 else e["minimo"]) * factor, -1)
        BD.aplicar_precio(uid, "demo", nuevo, e["sugerido"], motivo, p["tolerancia_excepcion"],
                          minimo=e["minimo"], maximo=e["maximo"], caso=e["caso"])
        fechar(datetime.now() - timedelta(days=azar.randint(0, 5)))
        if aprobada:
            with BD.con() as c:
                pid = c.execute("SELECT MAX(id) FROM precios_inventario WHERE unidad_id=?", (uid,)).fetchone()[0]
            BD.aprobar_excepcion(pid, "demo")

    # 6. revisión: unas al día y otras vencidas
    for uid, d in en_piso:
        if uid in [e[0] for e in excepciones]:
            continue
        with BD.con() as c:
            c.execute("UPDATE inventario SET ultima_revision=? WHERE id=?",
                      ((hoy - timedelta(days=min(d, azar.choice([1, 2, 4, 6, 9, 12, 16])))).isoformat(), uid))
    print(f"{n_piso} unidades en piso ({n_piso - len(CONFIANZA_BAJA)} del caso + 4 de confianza baja), {vendidas} vendidas y "
          f"{len(excepciones)} excepciones de precio creadas.")
    print(f"Omitidas por no estar en el catálogo del modelo: {len(omitidas)}" + (f" ({', '.join(sorted(set(omitidas)))})" if omitidas else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--borrar", action="store_true", help="quita las unidades demo")
    if ap.parse_args().borrar:
        print(f"{BD.borrar_demo()} unidades demo borradas.")
    else:
        sembrar()
