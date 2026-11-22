"""Gera o data.json usado pela consulta e pela auditoria de cadastro (IBS/CBS).

Fontes (veja scripts/baixar_fontes.sh para baixar tudo):
  --sinete      pasta src/data do pacote npm @sinete/ibs-cbs-dados
                (regras NCM da Calculadora oficial da Receita, módulo offline V0059,
                 e tabela cClassTrib do IT 2025.002 v1.60, com vigências e texto legal)
  --rtc         consulta-tributacao-rtc.json: resposta do serviço oficial de consulta da
                tabela de classificação tributária (SEFAZ), com data de publicação e
                indicação de uso em NF-e
  --ncm-map     arquivo dist/ncm.js.map do pacote npm @br-validators/core
                (NCMs de 8 dígitos, extraídos da tabela do Siscomex)
  --hierarquia  JSON da Nomenclatura do Siscomex (capítulos, posições e subposições)
  --condicoes   regras/condicoes.json (mantido à mão; cada condição cita um trecho
                do fundamento legal, que este script confere na fonte)

Nada é filtrado por data: as vigências (início e fim) vão para o data.json e a
análise escolhe o que vale na data da operação.

Uso:
  python scripts/build_data.py --sinete fontes/sinete/package/src/data \
      --rtc fontes/consulta-tributacao-rtc.json \
      --ncm-map fontes/brv/package/dist/ncm.js.map \
      --hierarquia fontes/ncm_siscomex.json --condicoes regras/condicoes.json --saida data.json
"""
import argparse
import hashlib
import json
import re
import sys
from urllib.parse import urlparse


def carregar(caminho, encoding="utf-8"):
    with open(caminho, encoding=encoding) as f:
        return json.load(f)


def vig(v):
    v = v or {}
    return [v.get("inicio"), v.get("fim")]


def sha256(caminho):
    with open(caminho, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# Links que vão para a página precisam ser https e de domínio do governo.
def url_oficial(u):
    if not u:
        return True
    p = urlparse(u)
    return p.scheme == "https" and (p.hostname or "").endswith(".gov.br")


def compacto(texto):
    return re.sub(r"\s+", " ", (texto or "").replace("\\n", " ")).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sinete", required=True)
    ap.add_argument("--rtc", required=True)
    ap.add_argument("--ncm-map", required=True)
    ap.add_argument("--hierarquia", required=True)
    ap.add_argument("--condicoes", default="regras/condicoes.json")
    ap.add_argument("--saida", default="data.json")
    a = ap.parse_args()

    s = a.sinete.rstrip("/") + "/"
    ct = carregar(s + "classTrib.json")
    cst = carregar(s + "cst.json")
    regras_ncm = carregar(s + "aplicabilidadeNcm.json")
    anexos = carregar(s + "anexos.json")
    manifesto = carregar(s + "manifest.json")
    rtc = carregar(a.rtc)
    cond = carregar(a.condicoes)

    fontes = [{"id": f["id"], "titulo": f["titulo"], "versao": f.get("versao"), "data": f["data"], "url": f.get("url")}
              for f in manifesto["fontes"] if f["id"] != "it-2025.002-v1.60-ccredpres"]
    pub_cst = {x["CST"]: x["Publicacao"][:10] for x in rtc}
    rtc_ct = {c["cClassTrib"]: c for x in rtc for c in x["classificacoesTributarias"]}
    pub_tabela = max(c["Publicacao"][:10] for c in rtc_ct.values())
    fontes.append({"id": "sefaz-consulta-tributacao", "versao": None, "data": pub_tabela, "url": None,
                   "titulo": "Tabela de classificação tributária do IBS/CBS (serviço de consulta da SEFAZ): publicação e uso por documento fiscal"})
    out = {"versoes": {"regras": manifesto["versaoDosDados"], "regrasData": manifesto["conhecidoEm"],
                       "tabelaPublicacao": pub_tabela}, "fontes": fontes}

    # 1) CST de IBS/CBS: grupos do XML exigidos ou vedados, vigência e publicação
    out["cst"] = {}
    for c in cst:
        if c["familia"] != "CBS_IBS":
            continue
        g = c.get("grupos") or {}
        out["cst"][c["codigo"]] = {
            "nome": c["descricao"], "ini": c["vigencia"]["inicio"], "fim": c["vigencia"]["fim"],
            "pub": pub_cst.get(c["codigo"]),
            "g": {k: v for k, v in g.items() if v != "vedado"},
        }

    # 2) cClassTrib de IBS/CBS com vigência, reduções datadas, texto legal e publicação
    out["ct"] = {}
    for c in ct:
        if c["familia"] != "CBS_IBS":
            continue
        legal = c.get("legal") or {}
        fund = legal.get("fundamento") or []
        r = rtc_ct.get(c["codigo"], {})
        out["ct"][c["codigo"]] = {
            "cst": c["cst"], "nome": c["nome"] or c["descricao"], "desc": c["descricao"],
            "anexo": c.get("anexo"), "nomencl": c.get("nomenclatura"),
            "ini": c["vigencia"]["inicio"], "fim": c["vigencia"]["fim"],
            "red": [[x["tributo"], float(x["pRed"]), *vig(x["vigencia"])] for x in (c.get("reducoes") or [])],
            "art": "; ".join(f["resumo"] for f in fund if f.get("resumo")) or None,
            "lei": [[f.get("resumo"), compacto(f.get("texto")), *vig(f.get("vigencia"))] for f in fund],
            "url": legal.get("url"),
            "pub": (r.get("Publicacao") or "")[:10] or None,
            "nfe": r.get("IndNFe"),
            "atual": c.get("atualizadoEm"),
        }

    # 3) Regras NCM -> cClassTrib. A fonte repete a mesma regra em várias linhas, cada
    #    uma com UMA exceção; as exceções são unidas por (prefixo, cClassTrib, item, vigência).
    def agrupar(linhas):
        grupos = {}
        for prefixo, excecoes, *resto in linhas:
            chave = (prefixo, *resto)
            if chave in grupos:
                atuais = {tuple(e) for e in grupos[chave][1]}
                grupos[chave][1] = sorted(atuais | {tuple(e) for e in excecoes})
            else:
                grupos[chave] = [prefixo, [tuple(e) for e in excecoes], *resto]
        return [[g[0], [list(e) for e in g[1]], *g[2:]] for g in grupos.values()]

    ibs_cbs, seletivo = [], []
    for r in regras_ncm:
        exc = [[e["prefixo"], *vig(e["vigencia"])] for e in r["excecoes"]]
        if r["familia"] == "CBS_IBS":
            ibs_cbs.append([r["prefixo"], exc, r["cClassTrib"], r.get("itemDoAnexo") or "", *vig(r["vigencia"])])
        else:
            seletivo.append([r["prefixo"], exc, r["cClassTrib"], *vig(r["vigencia"])])
    out["r"] = agrupar(ibs_cbs)
    out["is"] = agrupar(seletivo)
    nomes_is = {c["codigo"]: c["nome"] for c in ct if c["familia"] == "IS"}
    out["isNomes"] = {k: nomes_is[k] for k in sorted({r[2] for r in out["is"]}) if k in nomes_is}

    # 4) Texto de cada item dos anexos da LC 214, com vigência
    out["anx"] = {f"{x['anexo']}/{x['item']}": [x["texto"], *vig(x["vigencia"])] for x in anexos}

    # 5) Condições: confere o lastro de cada uma no texto legal da fonte
    def texto_legal(codigo):
        return " ".join(l[1] for l in out["ct"][codigo]["lei"])

    erros = []
    def conferir(lastro, onde):
        for l in lastro:
            if l["cClassTrib"] not in out["ct"]:
                erros.append(f"{onde}: cClassTrib {l['cClassTrib']} não existe na tabela")
            elif compacto(l["trecho"]) not in texto_legal(l["cClassTrib"]):
                erros.append(f"{onde}: trecho não encontrado no fundamento de {l['cClassTrib']}: {l['trecho']!r}")
    for k, c in cond["condicoes"].items():
        conferir(c["lastro"], f"condição {k}")
    for k, c in cond["lacunas"].items():
        conferir(c["lastro"], f"lacuna {k}")
    for k, ids in cond["porClassTrib"].items():
        for i in ids:
            if i.lstrip("!") not in cond["condicoes"]:
                erros.append(f"porClassTrib {k}: condição {i} não definida")
    termos = cond["itemRestrito"]["termos"]
    restritos = sorted(k for k, v in out["anx"].items() if any(t in v[0].lower() for t in termos))
    out["cond"] = {
        "operacoes": cond["operacoes"], "condicoes": cond["condicoes"], "porClassTrib": cond["porClassTrib"],
        "itensRestritos": restritos, "lacunas": cond["lacunas"],
    }

    # 6) NCMs de 8 dígitos (folhas) e hierarquia do Siscomex
    mapa = carregar(a.ncm_map)
    folhas = next(json.loads(c) for f, c in zip(mapa["sources"], mapa["sourcesContent"]) if f.endswith("ncm/data/ncm.json"))
    out["ncm"] = [[x["codigo"], x["descricao"]] for x in folhas]
    hier = carregar(a.hierarquia, encoding="utf-8-sig")
    out["tree"] = {re.sub(r"\D", "", n["Codigo"]): n["Descricao"]
                   for n in hier["Nomenclaturas"] if len(re.sub(r"\D", "", n["Codigo"])) < 8}
    out["versoes"]["ncm"] = "2026-09-20 (Siscomex)"
    out["versoes"]["hier"] = hier.get("Data_Ultima_Atualizacao_NCM", "")

    for k, lac in cond["lacunas"].items():
        for p in lac["posicoes"]:
            if not (out["tree"].get(p) or "").startswith(lac["conferirDescricao"]):
                erros.append(f"lacuna {k}: a posição {p} não começa com {lac['conferirDescricao']!r} na Nomenclatura")

    for k, t in out["ct"].items():
        if not url_oficial(t["url"]):
            erros.append(f"cClassTrib {k}: link fora de domínio oficial https: {t['url']!r}")
    for f in out["fontes"]:
        if not url_oficial(f["url"]):
            erros.append(f"fonte {f['id']}: link fora de domínio oficial https: {f['url']!r}")

    # Rastreabilidade: SHA-256 de cada arquivo de entrada usado neste data.json
    out["versoes"]["hashes"] = {
        "sinete/classTrib.json": sha256(s + "classTrib.json"),
        "sinete/aplicabilidadeNcm.json": sha256(s + "aplicabilidadeNcm.json"),
        "rtc": sha256(a.rtc), "ncm-map": sha256(a.ncm_map), "hierarquia": sha256(a.hierarquia),
        "condicoes": sha256(a.condicoes),
    }

    if erros:
        print("Falhas de validação das fontes:\n  " + "\n  ".join(erros), file=sys.stderr)
        sys.exit(1)

    with open(a.saida, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print({k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
