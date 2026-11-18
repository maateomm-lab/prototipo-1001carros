#!/usr/bin/env python3
"""Reconstruye la tabla de referencias de mercado del Apéndice E (Entrega 1) desde el Excel de precios.

Regla del Apéndice E: mediana, por familia y año, de los anuncios de Patiotuerca y Autocor del 7-oct-2026
(hoja "precios" de DATOS/insumos_v3/PRECIOS_MERCADO_2026-10-07.xlsx; las otras fuentes, como 1001carros.com, no entran).

Qué hace:
  1. Lee la hoja "precios", se queda con patiotuerca.com y autocor.com.ec y agrupa los modelos escritos de mil formas
     ("New Fortuner 4.0", "RAV 4", "Corolla HV XEI"...) en una familia normalizada.
  2. Calcula n y la mediana por familia y año.
  3. La compara con la tabla REF de datos_prototipo_v1_4.json (la del prototipo del grupo) y avisa si algo no coincide.
  4. Guarda el resultado en referencias_apendice_e.json (esa es la tabla que usa el prototipo).

Uso:   python reconstruir_referencias.py
Necesita pandas y openpyxl (ya instalados para el modelo).
"""
import json
import re
import statistics
from pathlib import Path

import pandas as pd

CARPETA = Path(__file__).resolve().parent
INSUMOS = CARPETA.parent.parent / "insumos_v3"
EXCEL = INSUMOS / "PRECIOS_MERCADO_2026-10-07.xlsx"
REF_JSON = INSUMOS / "datos_prototipo_v1_4.json"
SALIDA = CARPETA / "referencias_apendice_e.json"
FUENTES = ("patiotuerca.com", "autocor.com.ec")
FECHA = "2026-10-07"


def familia(modelo):
    """'New Fortuner 4.0' -> 'FORTUNER'; 'RAV 4' -> 'RAV4'; 'Corolla HV XEI' -> 'COROLLA'; 'DMax' -> 'D-MAX'."""
    s = re.sub(r"[^a-z0-9]", "", re.sub(r"^new\s+", "", str(modelo).strip().lower()))
    for clave, nombre in (("corolla", "COROLLA"), ("fortuner", "FORTUNER"), ("hilux", "HILUX"), ("yaris", "YARIS"),
                          ("rav4", "RAV4"), ("sportage", "SPORTAGE"), ("2008", "2008"), ("swift", "SWIFT"),
                          ("rush", "RUSH"), ("raize", "RAIZE"), ("dmax", "D-MAX")):
        if s.startswith(clave):
            return nombre
    return None


def mediana(valores):
    """Mediana como la calcula el Apéndice E; se redondea a USD 5 solo si queda con medio dólar (promedio de dos)."""
    m = statistics.median(valores)
    return int(m) if float(m).is_integer() else round(m, 1)


def reconstruir():
    df = pd.read_excel(EXCEL, sheet_name="precios")
    df.columns = ["fecha", "fuente", "vendedor", "marca", "modelo", "anio", "km", "precio", "ciudad", "f2", "neg",
                  "reb", "link", "cap"]
    df = df[df.fuente.isin(FUENTES)].copy()
    df["familia"] = df.modelo.map(familia)
    sin = df[df.familia.isna()]
    if len(sin):
        print("Modelos sin familia reconocida (no entran):", sorted(set(sin.modelo)))
    ref = {}
    for (fam, anio), g in df.dropna(subset=["familia", "anio", "precio"]).groupby(["familia", "anio"]):
        ref.setdefault(fam, {})[str(int(anio))] = dict(p=mediana(g.precio.tolist()), n=int(len(g)))
    return ref, len(df)


def comparar(ref):
    viejo = json.loads(REF_JSON.read_text(encoding="utf-8"))["REF"]
    difs = []
    for fam in sorted(set(ref) | set(viejo)):
        for anio in sorted(set(ref.get(fam, {})) | set(viejo.get(fam, {}))):
            a, b = ref.get(fam, {}).get(anio), viejo.get(fam, {}).get(anio)
            if a != b:
                difs.append((fam, anio, a, b))
    return difs


if __name__ == "__main__":
    ref, n = reconstruir()
    print(f"{n} anuncios de {' y '.join(FUENTES)} -> {len(ref)} familias, "
          f"{sum(len(v) for v in ref.values())} combinaciones familia-año")
    difs = comparar(ref)
    if difs:
        print("DIFERENCIAS contra REF de datos_prototipo_v1_4.json (familia, año, reconstruido, REF):")
        for d in difs:
            print("  ", d)
    else:
        print("Coincide exactamente con la tabla REF de datos_prototipo_v1_4.json.")
    c = ref.get("COROLLA", {}).get("2023")
    print(f"Prueba: Corolla 2023 = {c}  (Entrega 1: USD 21.800, 1 anuncio)")
    SALIDA.write_text(json.dumps(dict(fecha=FECHA, fuentes=list(FUENTES), regla="mediana por familia y año", ref=ref),
                                 ensure_ascii=False, indent=1), encoding="utf-8")
    print("Guardado:", SALIDA)
