#!/usr/bin/env bash
# Baixa as fontes de dados para a pasta fontes/ (não versionada).
# Versões fixas e conferidas por SHA-256: se um pacote ou arquivo mudar na origem,
# o script para em vez de gerar um data.json com dados não revisados.
# Para atualizar uma fonte: mude a versão, rode, revise as diferenças e atualize o hash.
set -euo pipefail
mkdir -p fontes && cd fontes

conferir() { # arquivo hash
  local obtido
  obtido=$(sha256sum "$1" | cut -d' ' -f1)
  if [ "$obtido" != "$2" ]; then
    echo "ERRO: $1 não confere (esperado $2, obtido $obtido). Fonte alterada na origem; revise antes de atualizar o hash." >&2
    exit 1
  fi
  echo "ok  $1"
}

# Regras de IBS/CBS (Calculadora da Receita + tabela cClassTrib), licença Apache-2.0
npm pack @sinete/ibs-cbs-dados@2026.9.3 --silent >/dev/null
conferir sinete-ibs-cbs-dados-2026.9.3.tgz a662f4505d3e64d92092feba535d3edc7b7333833a2c4efe22937b6e912faa9b
mkdir -p sinete && tar -xzf sinete-ibs-cbs-dados-2026.9.3.tgz -C sinete

# NCMs de 8 dígitos (tabela do Siscomex empacotada), licença MIT
npm pack @br-validators/core@1.10.0-data.46 --silent >/dev/null
conferir br-validators-core-1.10.0-data.46.tgz ea8ba79c305386de87c7d452c8f3d98a308518239b28661042320bbc1424ceed
mkdir -p brv && tar -xzf br-validators-core-1.10.0-data.46.tgz -C brv

# Resposta do serviço de consulta da tabela de classificação tributária (SEFAZ), licença Apache-2.0
curl -fsSL "https://raw.githubusercontent.com/souzamonteiro/nfeemissor/3a1610e3053e27417f28277ecdec009cf62843fb/nfeemissor/tabelas/consulta-tributacao-rtc.json" -o consulta-tributacao-rtc.json
conferir consulta-tributacao-rtc.json 1fe9351295a8de2df2b448eae6610621a1655ecb63024c87dc88fa456bdc0bd2

# Nomenclatura completa (capítulos e posições) direto do portal Classif do Siscomex.
# É a fonte oficial ao vivo, então não tem hash fixo: o build registra o SHA-256 do
# arquivo usado no data.json (versoes.hashes) para rastrear de onde veio cada versão.
curl -fsSL "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json" -o ncm_siscomex.json

echo "Fontes baixadas e conferidas em $(pwd)"
