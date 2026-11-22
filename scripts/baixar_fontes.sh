#!/usr/bin/env bash
# Baixa as fontes de dados para a pasta fontes/ (não versionada).
set -euo pipefail
mkdir -p fontes && cd fontes

# Regras de IBS/CBS (Calculadora da Receita + tabela cClassTrib), licença Apache-2.0
npm pack @sinete/ibs-cbs-dados --silent
mkdir -p sinete && tar -xzf sinete-ibs-cbs-dados-*.tgz -C sinete

# NCMs de 8 dígitos vigentes (tabela do Siscomex empacotada), licença MIT
npm pack @br-validators/core --silent
mkdir -p brv && tar -xzf br-validators-core-*.tgz -C brv

# Nomenclatura completa (com capítulos e posições) direto do portal Classif do Siscomex
curl -fsSL "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json" -o ncm_siscomex.json

echo "Fontes baixadas em $(pwd)"
