# Avisos sobre os dados

O arquivo `data.json` é derivado das seguintes fontes:

- **@sinete/ibs-cbs-dados** (Apache License 2.0), que reúne dados públicos da
  Calculadora de Tributos da Reforma Tributária do Consumo (Receita Federal do Brasil)
  e do Informe Técnico 2025.002. https://www.npmjs.com/package/@sinete/ibs-cbs-dados
  As exceções de cada regra foram unidas, as vigências foram mantidas e os campos
  foram renomeados para um formato compacto.
- **Consulta da tabela de classificação tributária (SEFAZ)**, resposta salva no projeto
  souzamonteiro/nfeemissor (Apache License 2.0): data de publicação e uso em NF-e.
  https://github.com/souzamonteiro/nfeemissor
- **@br-validators/core** (MIT), lista de NCMs de 8 dígitos extraída da tabela do Siscomex.
  https://www.npmjs.com/package/@br-validators/core
- **Nomenclatura Comum do Mercosul**, portal Classif do Siscomex (dados públicos).

As fontes tipográficas Public Sans e Courier Prime (pasta `fonts/`, via Fontsource) são
licenciadas pela SIL Open Font License 1.1; as licenças estão em `fonts/OFL-*.txt`.

As informações são de caráter informativo e não substituem a legislação nem a análise fiscal.
