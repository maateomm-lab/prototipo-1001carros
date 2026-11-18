"""Datos reales del caso (de DATOS/insumos_v3/datos_prototipo_v1_4.json, prototipo del grupo) y su cruce con el modelo.

  inventario_caso.json     72 unidades reales de la línea 1001: familia, año, km, días en inventario, agencia y región.
                           El costo de la base viene alterado: NO se usa como nivel (el costo se estima desde el modelo).
  anuncios_1001.json       100 anuncios reales de 1001carros.com del 7-oct-2026.
  historico_modelos.json   histórico de días en inventario por modelo (n, mediana, promedio, % >120 días, % ≤60 días).

Para regenerar los archivos desde el insumo:   python datos_caso.py
"""
import json
import re
import sys
from pathlib import Path

CARPETA = Path(__file__).resolve().parent / "datos_caso"
INSUMO = Path(__file__).resolve().parent.parent / "insumos_v3" / "datos_prototipo_v1_4.json"
MARGEN_INGRESO = 1.114      # costo de compra = valor de mercado al ingreso ÷ 1,114 (margen de ingreso de 10–12 % de la empresa)
MARGEN_PUBLICADO = 1.12     # precio publicado = costo × 1,12


def norm(s):
    """'Rav 4', 'NEW RAV4' y 'rav4' -> 'rav4'; 'Grand Vitara' -> 'grandvitara'."""
    s = re.sub(r"^new\s+", "", (s or "").strip().lower())
    return re.sub(r"[^a-z0-9ñ]", "", s)


def _leer(nombre):
    p = CARPETA / nombre
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def inventario_caso():
    return _leer("inventario_caso.json") or []


def anuncios_1001():
    return _leer("anuncios_1001.json") or []


def historico():
    return _leer("historico_modelos.json") or {}


def hist_de_familia(familia):
    """Histórico del modelo en la base del caso; None si hay muy pocas ventas. familia: 'toyota hilux' del catálogo."""
    h = historico().get("modelos", {})
    return h.get(norm((familia or "").split(" ", 1)[-1]))


def mapa_familias(art, conteos=None):
    """norm(texto de familia) -> (marca, familia del catálogo). Si varias marcas tienen el mismo texto gana la que
    tiene más avisos (conteos: {familia: n})."""
    conteos = conteos or {}
    mapa = {}
    for marca, fams in art["catalogo"].items():
        for fam in fams:
            k = norm(fam.split(" ", 1)[-1])
            if k not in mapa or conteos.get(fam, 0) > conteos.get(mapa[k][1], 0):
                mapa[k] = (marca, fam)
    return mapa


def buscar(mapa, texto):
    """(marca, familia) del catálogo para el texto de una familia del caso, o None."""
    k = norm(texto)
    if k in mapa:
        return mapa[k]
    for alias in {"rav4": "rav4", "grandvitara": "grandvitara", "dmax": "dmax"}.get(k, k), k.replace("new", ""):
        if alias in mapa:
            return mapa[alias]
    return None


def generar():
    d = json.loads(INSUMO.read_text(encoding="utf-8"))
    CARPETA.mkdir(exist_ok=True)
    esc = lambda n, v: (CARPETA / n).write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    esc("inventario_caso.json", [{k: u[k] for k in ("id", "f", "a", "k", "d", "ag", "rg")} for u in d["INV"]])
    esc("anuncios_1001.json", d["L"])
    h = {norm(k): v for k, v in d["HIST"].items() if not k.startswith("_")}
    esc("historico_modelos.json", dict(modelos=h, linea=d["HIST"].get("_LINEA"), distribucion=d["DIST"], ventas_2025=d["N25"]))
    print(f"inventario_caso: {len(d['INV'])} · anuncios: {len(d['L'])} · modelos con histórico: {len(h)}")


if __name__ == "__main__":
    generar()
