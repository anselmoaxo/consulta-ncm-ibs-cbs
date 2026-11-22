# Avisos sobre os dados

O arquivo `data.json` é derivado das seguintes fontes:

- **@sinete/ibs-cbs-dados** (Apache License 2.0), que reúne dados públicos da
  Calculadora de Tributos da Reforma Tributária do Consumo (Receita Federal do Brasil)
  e do Informe Técnico 2025.002. https://www.npmjs.com/package/@sinete/ibs-cbs-dados
  O conteúdo foi filtrado (só itens vigentes), as exceções de cada regra foram unidas
  e os campos foram renomeados para um formato compacto.
- **@br-validators/core** (MIT), lista de NCMs de 8 dígitos extraída da tabela do Siscomex.
  https://www.npmjs.com/package/@br-validators/core
- **Nomenclatura Comum do Mercosul**, portal Classif do Siscomex (dados públicos).

As informações são de caráter informativo e não substituem a legislação nem a análise fiscal.
