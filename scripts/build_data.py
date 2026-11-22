"""Gera o data.json usado pela página de consulta NCM -> IBS/CBS.

Fontes (veja scripts/baixar_fontes.sh para baixar tudo):
  --sinete     pasta src/data do pacote npm @sinete/ibs-cbs-dados
               (regras da Calculadora oficial da Receita + tabela cClassTrib do IT 2025.002)
  --ncm-map    arquivo dist/ncm.js.map do pacote npm @br-validators/core
               (NCMs de 8 dígitos vigentes, extraídos da tabela do Siscomex)
  --hierarquia JSON da Nomenclatura do Siscomex (portal Classif), usado para
               capítulos, posições e subposições

Uso:
  python scripts/build_data.py --sinete fontes/sinete/package/src/data \
      --ncm-map fontes/brv/package/dist/ncm.js.map \
      --hierarquia fontes/ncm_siscomex.json --data-ref 2026-11-21 --saida data.json
"""
import argparse
import json
import re
from datetime import date


def carregar(caminho, encoding="utf-8"):
    with open(caminho, encoding=encoding) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sinete", required=True)
    ap.add_argument("--ncm-map", required=True)
    ap.add_argument("--hierarquia", required=True)
    ap.add_argument("--data-ref", default=date.today().isoformat(), help="data de referência para vigências (AAAA-MM-DD)")
    ap.add_argument("--saida", default="data.json")
    a = ap.parse_args()
    hoje = a.data_ref

    def vigente_ou_futuro(v):
        return (v or {}).get("fim") is None or v["fim"] > hoje

    s = a.sinete.rstrip("/") + "/"
    ct = carregar(s + "classTrib.json")
    cst = carregar(s + "cst.json")
    regras_ncm = carregar(s + "aplicabilidadeNcm.json")
    anexos = carregar(s + "anexos.json")
    manifesto = carregar(s + "manifest.json")

    out = {"versoes": {
        "regras": manifesto["versaoDosDados"],
        "regrasData": manifesto["conhecidoEm"],
    }}

    # 1) Classificações tributárias (cClassTrib) de IBS/CBS ainda vigentes
    ctab = {}
    for c in ct:
        if c["familia"] != "CBS_IBS" or not vigente_ou_futuro(c["vigencia"]):
            continue
        red = {r["tributo"]: float(r["pRed"]) for r in (c.get("reducoes") or []) if vigente_ou_futuro(r["vigencia"])}
        legal = c.get("legal") or {}
        ctab[c["codigo"]] = {
            "cst": c["cst"], "nome": c["nome"], "desc": c["descricao"], "anexo": c.get("anexo"),
            "rCBS": red.get("CBS", 0.0), "rIBS": red.get("IBSUF", 0.0),
            "art": legal.get("lc214"), "url": legal.get("url"),
            "cred": bool((c.get("credito") or {}).get("adquirenteCbs")),
        }
    out["ct"] = ctab
    out["cst"] = {c["codigo"]: c["descricao"] for c in cst if c["familia"] == "CBS_IBS" and vigente_ou_futuro(c["vigencia"])}
    nomes_is = {c["codigo"]: c["nome"] for c in ct if c["familia"] == "IS"}

    # 2) Regras NCM -> cClassTrib. A fonte repete a mesma regra em várias linhas,
    #    cada uma com UMA exceção; juntamos as exceções de cada regra (união).
    #    Sem isso, um NCM excluído numa linha "voltaria" pela linha vizinha
    #    (ex.: arroz do Anexo I aparecendo também no Anexo VII).
    def agrupar(linhas):
        grupos = {}
        for prefixo, excecoes, *resto in linhas:
            chave = (prefixo, *resto)
            if chave in grupos:
                grupos[chave][1] = sorted(set(grupos[chave][1]) | set(excecoes))
            else:
                grupos[chave] = [prefixo, list(excecoes), *resto]
        return list(grupos.values())

    ibs_cbs, seletivo = [], []
    for r in regras_ncm:
        if not vigente_ou_futuro(r["vigencia"]):
            continue
        exc = [e["prefixo"] for e in r["excecoes"] if vigente_ou_futuro(e["vigencia"])]
        if r["familia"] == "CBS_IBS":
            if r["cClassTrib"] in ctab:
                ibs_cbs.append([r["prefixo"], exc, r["cClassTrib"], r.get("itemDoAnexo") or ""])
        else:
            seletivo.append([r["prefixo"], exc, r["cClassTrib"]])
    out["r"] = agrupar(ibs_cbs)
    out["is"] = agrupar(seletivo)
    out["isNomes"] = {k: nomes_is[k] for k in sorted({r[2] for r in out["is"]}) if k in nomes_is}

    # 3) Texto de cada item dos anexos da LC 214
    out["anx"] = {f"{x['anexo']}/{x['item']}": x["texto"] for x in anexos if vigente_ou_futuro(x["vigencia"])}

    # 4) NCMs de 8 dígitos (folhas)
    mapa = carregar(a.ncm_map)
    folhas = next(json.loads(c) for f, c in zip(mapa["sources"], mapa["sourcesContent"]) if f.endswith("ncm/data/ncm.json"))
    out["ncm"] = [[x["codigo"], x["descricao"]] for x in folhas]

    # 5) Hierarquia (capítulo, posição, subposição) da Nomenclatura do Siscomex
    hier = carregar(a.hierarquia, encoding="utf-8-sig")
    out["tree"] = {re.sub(r"\D", "", n["Codigo"]): n["Descricao"]
                   for n in hier["Nomenclaturas"] if len(re.sub(r"\D", "", n["Codigo"])) < 8}
    out["versoes"]["ncm"] = "2026-09-20 (Siscomex)"
    out["versoes"]["hier"] = hier.get("Data_Ultima_Atualizacao_NCM", "")

    with open(a.saida, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print({k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
