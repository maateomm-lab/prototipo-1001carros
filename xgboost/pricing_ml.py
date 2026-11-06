#!/usr/bin/env python3
"""
PROTOTIPO DE PRICING CON MACHINE LEARNING  (tesis 1001Carros)

Qué hace
  1. Limpia los avisos de Patio Tuerca (details.csv) y les une el precio de nuevo (precios_nuevos.csv).
  2. Compara 10 configuraciones fijas de XGBoost con validación cruzada (SOLO sobre el set de entrenamiento).
  3. Mide el error en un set de prueba que el modelo nunca vio.
  4. Calibra DOS rangos de precio adaptativos (conformal normalizado): probable (50%) y amplio (80%).
     El ancho depende de cada auto: angosto en autos comunes, ancho en autos raros o con pocos datos.
  5. Guarda todo en modelo_pricing.joblib para la app (app_pricing.py).

Versión 2: (a) 'modelo' se separa en FAMILIA (4Runner) + VERSIÓN (SR5) para que las versiones compartan
información; (b) se excluyen del entrenamiento los avisos con precios absurdamente bajos o iguales al km; (c) rangos adaptativos.

Uso
  python pricing_ml.py entrenar          (lee los datos de ../base/ automáticamente)
  python pricing_ml.py predecir --marca Toyota --modelo Hilux --anio 2018 --km 90000
"""
import argparse
from pathlib import Path
import re
import unicodedata
import warnings
from urllib.parse import unquote

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import KFold, cross_val_score, train_test_split

warnings.filterwarnings("ignore")

ANIO_REF = 2026
IVA = 1.15
MARGEN = 0.11            # margen promedio 10%-12% que indicó el concesionario (ajustable en la app)
COBERTURA = 0.80         # rango amplio: cubre ~80% de los casos
COBERTURA_PROBABLE = 0.50  # rango probable: cubre ~50% de los casos
UMBRAL_ABSURDO = 0.6     # log(precio/esperado) < -0.6 -> precio menor al 55% de lo esperado (cuota/entrada, error)
CAT = ["marca", "familia", "version", "modelo", "subtipo", "transmision", "combustible", "traccion", "ciudad", "provincia_placa",
       "vendedor_tipo", "climatizacion", "tapizado", "direccion", "vidrios"]
NUM = ["edad", "km", "km_anio", "cilindraje", "pn_sin_iva"]
CARPETA = Path(__file__).resolve().parent            # carpeta xgboost/
BASE = CARPETA.parent / "base"                       # carpeta base/ con los datos
USADOS_DEF = str(BASE / "details.csv")
NUEVOS_DEF = str(BASE / "precios_nuevos.csv")
ARTEFACTO = str(CARPETA / "modelo_pricing.joblib")
LIMITE_CONFIABLE = 60_000   # sobre este valor hay pocos avisos y el error sube (autos de lujo / exóticos)


# ----------------------------------------------------------------------------- compatibilidad entre computadoras
# El modelo se entrenó en Windows. En otras computadoras (Mac/Linux) XGBoost puede leer mal los nombres de categorías
# con tilde ("Sedán") y fallar. Para evitarlo se predice con los CÓDIGOS de categoría (posición en la lista guardada
# en el modelo), que son idénticos en cualquier sistema. El resultado es el mismo que en la computadora original.
def _dmatrix_codigos(X):
    Z = np.column_stack([X[c].cat.codes.replace(-1, np.nan).astype(float).values
                         if isinstance(X[c].dtype, pd.CategoricalDtype) else pd.to_numeric(X[c], errors="coerce").astype(float).values
                         for c in X.columns])
    tipos = ["c" if isinstance(X[c].dtype, pd.CategoricalDtype) else "q" for c in X.columns]
    return xgb.DMatrix(Z, feature_names=list(X.columns), feature_types=tipos, enable_categorical=True)


_predict_original = xgb.XGBRegressor.predict


def _predict_compatible(self, X, *a, **kw):
    if isinstance(X, pd.DataFrame) and any(isinstance(t, pd.CategoricalDtype) for t in X.dtypes) and not a and not kw:
        return self.get_booster().predict(_dmatrix_codigos(X))
    return _predict_original(self, X, *a, **kw)


xgb.XGBRegressor.predict = _predict_compatible


# ----------------------------------------------------------------------------- utilidades
def key(s):
    s = unicodedata.normalize("NFKD", unquote(str(s))).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


PREFIJOS = {"grand", "land", "santa", "range", "great", "model", "serie", "series", "clase", "class", "town", "mini"}


def familia_version(marca, modelo):
    """'4Runner SR5' -> ('toyota 4runner', 'sr5');  'RAV 4 2.5' -> ('toyota rav4', '2.5');  'Hilux' -> ('toyota hilux', 'base')."""
    if modelo is None or (isinstance(modelo, float) and np.isnan(modelo)):
        return None, None
    t = re.findall(r"[a-z0-9]+(?:\.[0-9]+)?", unicodedata.normalize("NFKD", str(modelo)).encode("ascii", "ignore")
                   .decode().lower().replace("-", ""))
    t = ["grand" if x == "gran" else x for x in t]
    while t and t[0] in {"new", "all", "nuevo", "nueva", "the"}:
        t = t[1:]
    if not t:
        return None, None
    if len(t) > 1 and t[0] in PREFIJOS:
        fam, resto = f"{t[0]} {t[1]}", t[2:]
    elif len(t) > 1 and t[0].isalpha() and (len(t[0]) == 1 or (len(t[0]) <= 3 and t[1].isdigit())):
        fam, resto = t[0] + t[1], t[2:]                     # 'rav 4' -> rav4, 'd max' -> dmax, 'cx 5' -> cx5
    else:
        fam, resto = t[0], t[1:]
    return f"{key(marca)} {fam}", (" ".join(resto) or "base")


def nombre_familia(fam):
    return fam.split(" ", 1)[1].title() if fam and " " in fam else str(fam)


def cargar_nuevos(path):
    n = pd.read_csv(path)
    n = n[~n.marca.astype(str).str.startswith("tipo_")].copy()
    n["mk"] = n.marca.map(key)
    n["modk"] = n.modelo.map(key)
    return n.dropna(subset=["precio_nuevo"])


def limpiar_usados(path):
    """Limpieza: NO se descartan autos por km alto (un auto viejo puede tener 500.000 km)."""
    d = pd.read_csv(path)
    n0 = len(d)
    d = d.dropna(subset=["precio", "anio", "marca", "modelo"])
    d = d[d["anio"].between(1980, 2027) & (d["precio"] >= 1500)].copy()
    d["edad"] = (ANIO_REF - d["anio"]).clip(lower=0)
    km = d["km"].astype(float)
    km[km > 2_000_000] = np.nan                                  # errores de digitación
    km[(km <= 10) & (d["edad"] >= 2)] = np.nan                   # "0/1/2 km" en autos usados
    km[(km / d["edad"].clip(lower=1)) > 100_000] = np.nan        # >100.000 km por año es irreal
    d["km"] = km
    d["km_anio"] = d["km"] / d["edad"].clip(lower=1)
    d["cilindraje"] = d["cilindraje"].where(d["cilindraje"] > 0)
    d = d.drop_duplicates(["marca", "modelo", "anio", "km", "precio"]).reset_index(drop=True)
    fv = [familia_version(m, x) for m, x in zip(d.marca, d.modelo)]
    d["familia"] = [a for a, b in fv]
    d["version"] = [b for a, b in fv]
    # el mismo auto publicado dos veces con distinto nombre ('4Runner' y '4Runner SR5', mismo km y precio)
    n1 = len(d)
    d = d.drop_duplicates(["marca", "familia", "anio", "km", "precio"]).reset_index(drop=True)
    print(f"  {n1 - len(d)} avisos repetidos con distinto nombre de modelo eliminados")
    print(f"Avisos: {n0} -> {len(d)} tras limpieza")
    return d


def _brand_match(k, marcas_nuevas):
    return [b for b in marcas_nuevas if b == k or b.startswith(k) or (len(b) > 3 and k.startswith(b))]


def buscar_pn(marca, modelo_txt, cil_cc, trans, trac, nuevos):
    """Precio de nuevo (con IVA) de la versión más parecida; None si el modelo no está en el catálogo actual."""
    mk, tk = key(marca), key(modelo_txt)
    marcas = sorted(nuevos.mk.unique())
    cands = []
    for b in _brand_match(mk, marcas):
        for m in nuevos[nuevos.mk == b].modk.unique():
            if len(m) >= 2 and m in tk.replace(mk, "", 1):
                cands.append((len(m), b, m))
    if not cands:
        return None
    _, b, m = sorted(cands, reverse=True)[0]
    g = nuevos[(nuevos.mk == b) & (nuevos.modk == m)]
    sc = np.zeros(len(g))
    if cil_cc and cil_cc > 0:
        sc += 2 * (np.abs(g.cilindraje_l - cil_cc / 1000) < 0.11).values
    if trans:
        sc += (g.transmision == trans).values * 1.0
    if trac:
        sc += (g.traccion == ("4x4" if str(trac).replace(" ", "") == "4x4" else "4x2")).values * 1.0
    return float(g[sc == sc.max()].precio_nuevo.median())


def unir_pn(d, nuevos):
    pn = []
    for r in d.itertuples():
        pn.append(buscar_pn(r.marca, f"{r.marca} {r.titulo}", r.cilindraje, r.transmision, r.traccion, nuevos))
    d["pn_con_iva"] = pn
    d["pn_sin_iva"] = d.pn_con_iva / IVA
    print(f"Con precio de nuevo: {d.pn_con_iva.notna().sum()} de {len(d)} ({d.pn_con_iva.notna().mean()*100:.0f}%)")
    return d


# ----------------------------------------------------------------------------- matriz de variables
def crear_categorias(d):
    cats = {}
    for c in CAT:
        col = d[c].dropna().astype(str)
        cats[c] = list(dict.fromkeys(list(col.value_counts().index[:250]) + ["OTRO"]))
    return cats


def matriz(d, cats):
    X = pd.DataFrame(index=d.index)
    for c in CAT:
        col = d[c].astype("object").where(d[c].notna(), np.nan)
        col = col.where(col.isin(cats[c]) | col.isna(), "OTRO")
        X[c] = pd.Categorical(col, categories=cats[c])
    for c in NUM:
        X[c] = pd.to_numeric(d[c], errors="coerce")
    return X


OPCIONALES = ["modelo", "version", "subtipo", "transmision", "combustible", "traccion", "ciudad", "provincia_placa", "climatizacion",
              "tapizado", "direccion", "vidrios", "cilindraje", "km", "km_anio"]


def enmascarar(X, y, copias=2, p=.30, semilla=0):
    """Aumenta el entrenamiento con copias a las que se les borran campos opcionales al azar.
    Así el modelo aprende a estimar cuando el usuario no conoce todos los datos del auto."""
    rng = np.random.default_rng(semilla)
    Xs, ys = [X], [y]
    for _ in range(copias):
        Xm = X.copy()
        for c in OPCIONALES:
            borrar = rng.random(len(Xm)) < p
            if c in CAT:
                Xm[c] = Xm[c].astype("object").mask(borrar, np.nan).astype(X[c].dtype)
            else:
                Xm.loc[borrar, c] = np.nan
        Xs.append(Xm)
        ys.append(y)
    return pd.concat(Xs, ignore_index=True), np.concatenate(ys)


def xgb_base(**kw):
    p = dict(n_estimators=900, learning_rate=.04, max_depth=7, subsample=.8, colsample_bytree=.8, reg_lambda=2,
             min_child_weight=3, enable_categorical=True, tree_method="hist", random_state=0, n_jobs=-1,
             # regla de negocio: con todo lo demás igual, MÁS kilometraje nunca puede SUBIR el precio
             monotone_constraints={"km": -1})
    p.update(kw)
    return xgb.XGBRegressor(**p)


def metricas(real, pred):
    a = np.abs(pred - real) / real
    return {"MdAPE %": float(np.median(a) * 100), "MAPE %": float(a.mean() * 100),
            "RMSE USD": float(np.sqrt(np.mean((pred - real) ** 2))),
            "R2": float(1 - np.sum((pred - real) ** 2) / np.sum((real - real.mean()) ** 2)),
            "±10 %": float(np.mean(a <= .10) * 100), "±15 %": float(np.mean(a <= .15) * 100)}


# ----------------------------------------------------------------------------- entrenamiento
def oof_simple(X, y, folds=3):
    """Predicción fuera de muestra (cada aviso lo predice un modelo que no lo vio). Sirve para detectar absurdos."""
    p = np.zeros(len(X))
    for tr, te in KFold(folds, shuffle=True, random_state=7).split(X):
        p[te] = xgb_base(n_estimators=500, learning_rate=.06).fit(X.iloc[tr], y[tr]).predict(X.iloc[te])
    return p


def datos_dificultad(X, y, params, folds=3):
    """Errores fuera de muestra (con datos completos y con campos borrados) para enseñarle al
    'modelo de dificultad' cuánto suele equivocarse el modelo en cada tipo de auto."""
    Xs, es = [], []
    for k, (tr, te) in enumerate(KFold(folds, shuffle=True, random_state=11).split(X)):
        Xa, ya = enmascarar(X.iloc[tr], y[tr], copias=1, semilla=k)
        m = xgb_base(**params).fit(Xa, ya)
        Xm, _ = enmascarar(X.iloc[te], y[te], copias=1, semilla=100 + k)
        Xs.append(Xm)
        es.append(np.abs(np.concatenate([y[te], y[te]]) - m.predict(Xm)))
    return pd.concat(Xs, ignore_index=True), np.concatenate(es)


def modelo_dificultad(X, e):
    return xgb.XGBRegressor(n_estimators=300, learning_rate=.05, max_depth=4, min_child_weight=10,
                            enable_categorical=True, tree_method="hist", objective="reg:absoluteerror",
                            random_state=0, n_jobs=-1).fit(X, e)


def sigma(mdif, X):
    return np.clip(mdif.predict(X), .03, None)


def cuantil(s, cob):
    k = int(np.ceil((len(s) + 1) * cob))
    return float(np.sort(s)[min(k, len(s)) - 1])


def entrenar(usados, nuevos, salida=ARTEFACTO, n_iter=15):
    d = unir_pn(limpiar_usados(usados), cargar_nuevos(nuevos))
    cats = crear_categorias(d)
    X, y = matriz(d, cats), np.log(d.precio.values)
    r = d.precio.values

    print("Buscando avisos con precios absurdos (validación cruzada)...")
    p_oof = oof_simple(X, y)
    # Solo se excluyen precios MUY BAJOS para el auto (suelen ser cuotas, entradas, autos chocados o errores)
    # y precios iguales al kilometraje (error de digitación). Los muy ALTOS se conservan: casi siempre son
    # autos de lujo/deportivos reales, y quitarlos empeora el modelo en esa gama.
    absurdo = ((y - p_oof) < -UMBRAL_ABSURDO) | (d.precio.values == d.km.values)
    d.loc[absurdo, ["titulo", "anio", "km", "precio"]].assign(esperado=np.exp(p_oof[absurdo]).round(0)) \
        .to_csv(CARPETA / "avisos_absurdos.csv", index=False, encoding="utf-8-sig")
    print(f"  {absurdo.sum()} avisos excluidos del entrenamiento (lista en avisos_absurdos.csv)")

    idx = np.arange(len(d))
    i_tr, i_te = train_test_split(idx, test_size=.15, random_state=42)
    i_tr, i_ca = train_test_split(i_tr, test_size=.176, random_state=42)    # ~70 / 15 / 15
    i_tr_ok = i_tr[~absurdo[i_tr]]
    print(f"Entrenamiento {len(i_tr_ok)} | calibración {len(i_ca)} | prueba {len(i_te)}")

    # Grilla FIJA (igual en cualquier computadora). La primera es la configuración de fábrica.
    # Se mide con el error MEDIANO (lo mismo que el MdAPE que reportamos) y una configuración solo
    # reemplaza a la de fábrica si la mejora en más de 1%; si no, es empate y se queda la simple.
    grilla = [{}, dict(max_depth=5), dict(max_depth=6), dict(max_depth=8, min_child_weight=5),
              dict(learning_rate=.03, n_estimators=1300), dict(max_depth=6, learning_rate=.03, n_estimators=1300),
              dict(max_depth=8, learning_rate=.02, n_estimators=1800, min_child_weight=5),
              dict(reg_lambda=10, max_depth=6), dict(colsample_bytree=.6, max_depth=8), dict(subsample=.7, max_depth=6)]
    print(f"Comparando {len(grilla)} configuraciones de XGBoost (validación cruzada 3 folds, solo entrenamiento)...")
    cv = KFold(3, shuffle=True, random_state=0)
    err = []
    for g in grilla:
        e = -cross_val_score(xgb_base(**g), X.iloc[i_tr_ok], y[i_tr_ok], cv=cv,
                             scoring="neg_median_absolute_error").mean()
        err.append(e)
        print(f"  error mediano {(np.exp(e) - 1) * 100:5.2f}%  {g or 'configuración de fábrica'}")
    k = int(np.argmin(err))
    mejor = grilla[k] if err[k] < err[0] * 0.99 else {}
    print("Hiperparámetros elegidos:", mejor or "configuración de fábrica (ninguna otra la mejora en más de 1%)")

    base = xgb_base().fit(X.iloc[i_tr_ok], y[i_tr_ok])          # referencia: sin afinar y sin datos borrados
    Xa, ya = enmascarar(X.iloc[i_tr_ok], y[i_tr_ok])
    afin = xgb_base(**mejor).fit(Xa, ya)                     # entrenado con datos completos + copias incompletas
    p_te = afin.predict(X.iloc[i_te])
    m_base = metricas(r[i_te], np.exp(base.predict(X.iloc[i_te])))
    m_afin = metricas(r[i_te], np.exp(p_te))
    ok_te = r[i_te] < LIMITE_CONFIABLE
    m_ok = metricas(r[i_te][ok_te], np.exp(p_te[ok_te]))
    m_lujo = metricas(r[i_te][~ok_te], np.exp(p_te[~ok_te]))
    Xinc, _ = enmascarar(X.iloc[i_te], y[i_te], copias=1, p=.5, semilla=5)
    Xinc = Xinc.iloc[len(i_te):]                              # solo la copia con la mitad de los campos borrados
    m_inc = metricas(r[i_te], np.exp(afin.predict(Xinc)))
    con_pn = d.pn_con_iva.iloc[i_te].notna().values
    m_pn = metricas(r[i_te][con_pn], np.exp(p_te[con_pn]))
    m_sin = metricas(r[i_te][~con_pn], np.exp(p_te[~con_pn]))

    # rangos adaptativos (conformal normalizado): error típico esperado para ESTE auto x factor calibrado
    print("Calibrando rangos adaptativos...")
    Xd, ed = datos_dificultad(X.iloc[i_tr_ok].reset_index(drop=True), y[i_tr_ok], mejor)
    mdif = modelo_dificultad(Xd, ed)
    Xc, yc = enmascarar(X.iloc[i_ca], y[i_ca], copias=1, semilla=21)   # calibra con autos completos e incompletos
    sc = np.abs(yc - afin.predict(Xc)) / sigma(mdif, Xc)
    q80, q50 = cuantil(sc, COBERTURA), cuantil(sc, COBERTURA_PROBABLE)
    s_te, s_inc = sigma(mdif, X.iloc[i_te]), sigma(mdif, Xinc)
    e_te, e_inc = np.abs(y[i_te] - p_te), np.abs(y[i_te] - afin.predict(Xinc))
    ancho = lambda q, s: (np.exp(q * s) - 1) * 100
    rangos = {
        "probable (50%)": dict(cobertura_real=float(np.mean(e_te <= q50 * s_te) * 100),
                               cobertura_incompletos=float(np.mean(e_inc <= q50 * s_inc) * 100),
                               mas_menos_mediano=float(np.median(ancho(q50, s_te))),
                               ancho_mediano_usd=float(np.median(np.exp(p_te) * 2 * np.sinh(q50 * s_te)))),
        "amplio (80%)": dict(cobertura_real=float(np.mean(e_te <= q80 * s_te) * 100),
                             cobertura_incompletos=float(np.mean(e_inc <= q80 * s_inc) * 100),
                             mas_menos_mediano=float(np.median(ancho(q80, s_te))),
                             ancho_mediano_usd=float(np.median(np.exp(p_te) * 2 * np.sinh(q80 * s_te))))}

    print("\n=== Resultados en el set de PRUEBA (datos que el modelo nunca vio) ===")
    print(pd.DataFrame({"XGBoost sin afinar": m_base, "XGBoost afinado": m_afin,
                        "  autos bajo $60.000": m_ok, "  autos sobre $60.000": m_lujo,
                        "  con precio de nuevo": m_pn, "  sin precio de nuevo": m_sin,
                        "afinado, 50% de campos borrados": m_inc}).round(2).T.to_string())
    print("\n=== Rangos de precio ===")
    print(pd.DataFrame(rangos).round(1).T.to_string())

    print("\nEntrenando modelo final con todos los datos...")
    ok = ~absurdo
    Xf, yf = enmascarar(X[ok], y[ok])
    final = xgb_base(**mejor).fit(Xf, yf)
    Xd, ed = datos_dificultad(X[ok].reset_index(drop=True), y[ok], mejor)
    mdif_final = modelo_dificultad(Xd, ed)

    catalogo = {}            # marca -> familia -> versión -> texto de modelo más común
    for (mk, fam, ver), g in d.dropna(subset=["familia"]).groupby(["marca", "familia", "version"]):
        catalogo.setdefault(mk, {}).setdefault(fam, {})[ver] = g.modelo.astype(str).value_counts().index[0]
    art = dict(modelo=final, dificultad=mdif_final, cats=cats, q=q80, q50=q50, margen=MARGEN, cobertura=COBERTURA,
               cobertura_probable=COBERTURA_PROBABLE, nuevos=cargar_nuevos(nuevos), catalogo=catalogo,
               hiperparametros=mejor, rangos=rangos, n_absurdos=int(absurdo.sum()),
               metricas=dict(sin_afinar=m_base, afinado=m_afin, bajo_60k=m_ok, sobre_60k=m_lujo, con_pn=m_pn, sin_pn=m_sin,
                             datos_incompletos=m_inc, cobertura_real=rangos["amplio (80%)"]["cobertura_real"]),
               n_entrenamiento=len(d), valores={c: sorted(d[c].dropna().astype(str).unique())[:300] for c in
                                                 ["subtipo", "transmision", "combustible", "traccion", "ciudad",
                                                  "provincia_placa", "vendedor_tipo", "climatizacion", "tapizado",
                                                  "direccion", "vidrios"]})
    joblib.dump(art, salida)
    print(f"\nModelo guardado en {salida}")
    return art


# ----------------------------------------------------------------------------- predicción
GRUPO = {"marca": "Marca", "familia": "Modelo y versión", "version": "Modelo y versión", "modelo": "Modelo y versión",
         "edad": "Año (antigüedad)", "km": "Kilometraje", "km_anio": "Kilometraje", "pn_sin_iva": "Precio de nuevo",
         "subtipo": "Carrocería", "transmision": "Transmisión", "combustible": "Combustible", "traccion": "Tracción",
         "ciudad": "Ciudad", "provincia_placa": "Placa", "vendedor_tipo": "Vendedor", "climatizacion": "Equipamiento",
         "tapizado": "Equipamiento", "direccion": "Equipamiento", "vidrios": "Equipamiento", "cilindraje": "Cilindraje"}


def predecir(art, marca, modelo=None, anio=2018, km=None, cilindraje=None, subtipo=None, transmision=None,
             combustible=None, traccion=None, ciudad=None, provincia_placa=None, vendedor_tipo=None,
             climatizacion=None, tapizado=None, direccion=None, vidrios=None, pn_con_iva=None, margen=None,
             familia=None, version=None):
    """Valor de mercado, rangos probable (50%) y amplio (80%), precio de toma y qué sumó/restó cada variable.
    Se puede dar 'modelo' (texto, ej. '4Runner SR5') o 'familia' + 'version' (versión None = no se sabe)."""
    margen = art["margen"] if margen is None else margen
    if modelo and not familia:
        familia, version = familia_version(marca, modelo)
    if pn_con_iva is None:
        txt = modelo or f"{nombre_familia(familia)} {'' if version in (None, 'base') else version}"
        pn_con_iva = buscar_pn(marca, f"{marca} {txt}", cilindraje, transmision, traccion, art["nuevos"])
    edad = max(ANIO_REF - int(anio), 0)
    fila = pd.DataFrame([dict(marca=marca, familia=familia, version=version, modelo=modelo, subtipo=subtipo,
                              transmision=transmision, combustible=combustible, traccion=traccion, ciudad=ciudad,
                              provincia_placa=provincia_placa, vendedor_tipo=vendedor_tipo,
                              climatizacion=climatizacion, tapizado=tapizado, direccion=direccion, vidrios=vidrios,
                              edad=edad, km=km if km is not None else np.nan,
                              km_anio=(km / max(edad, 1)) if km is not None else np.nan,
                              cilindraje=cilindraje if cilindraje else np.nan,
                              pn_sin_iva=(pn_con_iva / IVA) if pn_con_iva else np.nan)])
    X = matriz(fila, art["cats"])
    mu = float(art["modelo"].predict(X)[0])
    s = float(sigma(art["dificultad"], X)[0])
    q80, q50 = art["q"] * s, art["q50"] * s
    mercado = np.exp(mu)
    bajo, alto, bajo50, alto50 = np.exp(mu - q80), np.exp(mu + q80), np.exp(mu - q50), np.exp(mu + q50)
    contrib = art["modelo"].get_booster().predict(_dmatrix_codigos(X), pred_contribs=True)[0]
    agrupado = {}
    for n, c in zip(CAT + NUM, contrib[:-1]):
        agrupado[GRUPO.get(n, n)] = agrupado.get(GRUPO.get(n, n), 0.0) + float(c)
    efectos = {n: float(np.exp(c) - 1) for n, c in agrupado.items()}
    t = lambda v: v / (1 + margen)
    return dict(mercado=mercado, bajo=bajo, alto=alto, bajo50=bajo50, alto50=alto50, margen=margen,
                fuera_de_rango=bool(mercado > LIMITE_CONFIABLE), toma=t(mercado), toma_bajo=t(bajo),
                toma_alto=t(alto), toma_bajo50=t(bajo50), toma_alto50=t(alto50), pn_con_iva=pn_con_iva,
                efectos=efectos, base=float(np.exp(contrib[-1])), familia=familia, version=version)


# ----------------------------------------------------------------------------- curvas de depreciación
def _suavizar_decreciente(df, x, cols):
    """Ajuste isotónico: la curva queda decreciente (más km / más años nunca suben el precio) y lo más
    pegada posible a lo que dice el modelo. Corrige pequeños saltos de 1-4% en zonas con pocos datos."""
    from sklearn.isotonic import IsotonicRegression
    for c in cols:
        df[c] = IsotonicRegression(increasing=False).fit_transform(df[x], df[c])
    return df


def curva_km(art, km_max=None, paso=10_000, **auto):
    """Valor del MISMO auto con distintos kilometrajes (todo lo demás fijo). Devuelve una tabla km -> valores."""
    km_act = auto.get("km") or 0
    km_max = km_max or max(250_000, int(km_act * 1.8 / paso + 1) * paso)
    filas = []
    for k in range(0, km_max + 1, paso):
        r = predecir(art, **{**auto, "km": float(k)})
        filas.append(dict(km=k, mercado=r["mercado"], bajo50=r["bajo50"], alto50=r["alto50"], toma=r["toma"]))
    return _suavizar_decreciente(pd.DataFrame(filas), "km", ["mercado", "bajo50", "alto50", "toma"])


def curva_anios(art, anios=6, km_por_anio=None, **auto):
    """Proyección: cuánto valdría este auto en los próximos años si sigue rodando al mismo ritmo.
    Usa el precio de hoy de autos del mismo modelo que ya tienen esa antigüedad (no predice inflación)."""
    anio, km = int(auto["anio"]), auto.get("km")
    edad = max(ANIO_REF - anio, 0)
    if km_por_anio is None:
        km_por_anio = (km / edad) if (km and edad >= 1) else 14_500     # mediana del mercado ecuatoriano
    filas = []
    for t in range(anios + 1):
        k = (km or edad * km_por_anio) + t * km_por_anio
        r = predecir(art, **{**auto, "anio": anio - t, "km": float(k)})
        filas.append(dict(dentro_de_anios=t, km=k, mercado=r["mercado"], bajo50=r["bajo50"], alto50=r["alto50"],
                          toma=r["toma"]))
    out = _suavizar_decreciente(pd.DataFrame(filas), "dentro_de_anios", ["mercado", "bajo50", "alto50", "toma"])
    out["perdida_acumulada_%"] = (1 - out.mercado / out.mercado.iloc[0]) * 100
    return out


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("entrenar")
    e.add_argument("--usados", default=USADOS_DEF)
    e.add_argument("--nuevos", default=NUEVOS_DEF)
    e.add_argument("--salida", default=ARTEFACTO)
    e.add_argument("--iter", type=int, default=15)
    p = sub.add_parser("predecir")
    p.add_argument("--marca", required=True)
    p.add_argument("--modelo", required=True)
    p.add_argument("--anio", type=int, required=True)
    p.add_argument("--km", type=float, required=True)
    p.add_argument("--cilindraje", type=float)
    p.add_argument("--provincia", dest="provincia_placa")
    p.add_argument("--subtipo")
    p.add_argument("--transmision")
    p.add_argument("--traccion")
    p.add_argument("--combustible")
    p.add_argument("--ciudad")
    p.add_argument("--vendedor", dest="vendedor_tipo", default="particular")
    p.add_argument("--margen", type=float)
    a = ap.parse_args()
    if a.cmd == "entrenar":
        entrenar(a.usados, a.nuevos, a.salida, a.iter)
    else:
        art = joblib.load(ARTEFACTO)
        r = predecir(art, a.marca, a.modelo, a.anio, a.km, a.cilindraje, subtipo=a.subtipo,
                     provincia_placa=a.provincia_placa, transmision=a.transmision,
                     traccion=a.traccion, combustible=a.combustible, ciudad=a.ciudad,
                     vendedor_tipo=a.vendedor_tipo, margen=a.margen)
        print(f"Familia/versión detectada : {nombre_familia(r['familia'])} / {r['version']}")
        print(f"Valor de mercado estimado : ${r['mercado']:,.0f}")
        print(f"  rango probable (50%)    : ${r['bajo50']:,.0f} - ${r['alto50']:,.0f}")
        print(f"  rango amplio   (80%)    : ${r['bajo']:,.0f} - ${r['alto']:,.0f}")
        print(f"Precio de toma (margen {r['margen']*100:.0f}%): ${r['toma']:,.0f}  (probable ${r['toma_bajo50']:,.0f} - ${r['toma_alto50']:,.0f})")
        if r["fuera_de_rango"]:
            print("AVISO: auto sobre $60.000, zona con pocos datos; tomar el resultado como referencia.")
        top = sorted(r["efectos"].items(), key=lambda kv: -abs(kv[1]))[:6]
        print("Lo que más pesó:", ", ".join(f"{k} {v*100:+.0f}%" for k, v in top))


if __name__ == "__main__":
    main()
