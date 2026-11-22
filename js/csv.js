// Leitura e escrita de CSV sem converter nada para número (zeros à esquerda ficam).
// Aceita vírgula ou ponto e vírgula, aspas com "" escapado, quebras de linha dentro de
// aspas, CRLF e BOM. Cada registro guarda a linha física onde começa no arquivo original.

export function detectarDelimitador(texto) {
  const s = texto.replace(/^﻿/, '');
  let aspas = false, pv = 0, v = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') aspas = !aspas;
    else if (!aspas && (ch === '\n' || ch === '\r')) { if (pv || v) break; }
    else if (!aspas && ch === ';') pv++;
    else if (!aspas && ch === ',') v++;
  }
  return v > pv ? ',' : ';';
}

export function lerCSV(texto, delimitador) {
  const s = texto.replace(/^﻿/, '');
  const d = delimitador || detectarDelimitador(s);
  const registros = [];
  let campos = [], campo = '', aspas = false, linha = 1, inicio = 1, i = 0;
  const fimRegistro = () => {
    campos.push(campo);
    if (!(campos.length === 1 && campos[0].trim() === '')) registros.push({linha: inicio, campos});
    campos = []; campo = '';
  };
  while (i < s.length) {
    const ch = s[i];
    if (aspas) {
      if (ch === '"') {
        if (s[i + 1] === '"') { campo += '"'; i += 2; continue; }
        aspas = false; i++; continue;
      }
      if (ch === '\n') linha++;
      campo += ch; i++; continue;
    }
    if (ch === '"' && campo === '') { aspas = true; i++; continue; }
    if (ch === d) { campos.push(campo); campo = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      fimRegistro();
      if (ch === '\r' && s[i + 1] === '\n') i++;
      i++; linha++; inicio = linha; continue;
    }
    campo += ch; i++;
  }
  if (campo !== '' || campos.length) fimRegistro();
  const [cab, ...dados] = registros;
  return {delimitador: d, cabecalho: cab ? cab.campos.map(c => c.trim()) : [], registros: dados};
}

const precisaAspas = (v, d) => v.includes(d) || v.includes('"') || v.includes('\n') || v.includes('\r') || /^\s|\s$/.test(v);

// Proteção contra injeção de fórmula (CSV injection): uma célula que começa com
// = + - @ TAB ou CR vira fórmula ao abrir no Excel/Planilhas. Prefixamos com apóstrofo,
// que o Excel trata como "texto" e não exibe. Recomendação OWASP.
const INICIO_FORMULA = /^[=+\-@\t\r]/;
export const neutralizarFormula = s => (INICIO_FORMULA.test(s) ? "'" + s : s);

export function escreverCSV(linhas, delimitador = ';') {
  if (!linhas.length) return '';
  const cab = Object.keys(linhas[0]);
  const fmt = v => {
    const s = neutralizarFormula(v == null ? '' : String(v));
    return precisaAspas(s, delimitador) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cab, ...linhas.map(l => cab.map(k => l[k]))].map(r => r.map(fmt).join(delimitador)).join('\r\n') + '\r\n';
}
