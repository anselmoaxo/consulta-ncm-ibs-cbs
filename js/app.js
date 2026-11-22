// Interface: "Consultar produto" e "Auditar cadastro". Toda regra fiscal está em fiscal.js.
import {criarBase, analisar, analisarLinha, previaXml, sugerirMapeamento, linhaExportacao, COLUNAS,
  SITUACOES, ORDEM, SEM_REGRA, fmtNcm, fmtData, caminho, tabelaClassTrib} from './fiscal.js';
import {lerCSV, escreverCSV} from './csv.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmt = (v, d = 2) => v.toLocaleString('pt-BR', {minimumFractionDigits: d, maximumFractionDigits: d});
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, '').toLowerCase();
const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/^[\s-]+/, '');
const hojeIso = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); })();
const hoje = fmtData(hojeIso);

// Alíquotas de referência só para a simulação de valores (não entram no diagnóstico).
const ANOS = {
  2026: {CBS: 0.9, UF: 0.1, MUN: 0, nota: 'Em 2026 IBS e CBS são destacados na nota em caráter de teste, sem recolhimento, e o vTotDFe não soma esses valores.'},
  2027: {CBS: 11.2, UF: 0.05, MUN: 0.05, nota: 'Alíquota de referência, não oficial: CBS de 11,2% (estimativa de 11,3% do TCU menos 0,1 ponto; a alíquota é fixada pelo Senado). IBS em 0,05% + 0,05%.'},
};
const LIMITE_CSV = 20 * 1048576; // 20 MB: evita travar a aba com arquivos gigantes
// Só links https de domínios do governo (os dados vêm de fonte oficial; isto é uma barreira extra).
const urlSegura = u => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)gov\.br$/.test(x.hostname) ? x.href : null; } catch (e) { return null; } };
const EXEMPLOS = [['10063021', 'arroz'], ['04072100', 'ovos'], ['33061000', 'creme dental'], ['01022110', 'bovino reprodutor'], ['30049099', 'medicamento'], ['22030000', 'cerveja']];

let B = null, IDX = [];
const st = {modo: 'consulta', code: null, data: hojeIso, op: 'venda', respostas: {}, sel: null, ano: 2027, base: 1000, cad: null};
try { const s = JSON.parse(localStorage.getItem('ncmibs') || '{}'); if (ANOS[s.ano]) st.ano = s.ano; if (s.base >= 0) st.base = s.base; } catch (e) {}
const save = () => { try { localStorage.setItem('ncmibs', JSON.stringify({ano: st.ano, base: st.base})); } catch (e) {} };

// ================= consulta =================
$('#ex').insertAdjacentHTML('beforeend', EXEMPLOS.map(([c, n]) => `<button type="button" data-c="${c}">${n}</button>`).join(''));

function vazio() {
  $('#res').innerHTML = `<div class="estado"><strong>Digite um NCM ou o nome de um produto.</strong> Escolha a data e a operação: o resultado mostra os enquadramentos possíveis, o que falta confirmar, a fonte e o trecho do XML da NF-e. Para revisar vários produtos de uma vez, use <a href="#auditoria">Auditar cadastro</a>.</div>`;
}
function erro(msg, detalhe = '') { $('#res').innerHTML = `<div class="estado erro" role="alert"><strong>${esc(msg)}</strong>${detalhe ? `<p class="u-mt6 nota">${esc(detalhe)}</p>` : ''}</div>`; }

const tag = s => `<span class="tag s-${s}">${SITUACOES[s]}</span>`;
const estadoE = {aplicavel: 'Aplica-se', pendente: 'Depende de confirmação', excluido: 'Não se aplica a esta operação'};

function achadosHtml(r) {
  return `<ul class="achados">${r.achados.map(a => `<li class="achado s-${a.situacao}"><p><strong>${SITUACOES[a.situacao]}:</strong> ${esc(a.motivo)}</p><p class="acao"><strong>O que fazer:</strong> ${esc(a.acao)}</p>${a.referencia ? `<p class="ref">Referência: ${esc(a.referencia)}</p>` : ''}</li>`).join('')}</ul>`;
}

function perguntasHtml(r) {
  const vistas = new Map();
  for (const e of r.enquadramentos) for (const c of e.condicoes) if (c.origem === 'pergunta' && !vistas.has(c.id)) vistas.set(c.id, c);
  if (!vistas.size) return '';
  return `<div class="perguntas"><h3 class="u-h3">Responda para fechar o enquadramento</h3>${[...vistas.values()].map(c => `
    <div class="pergunta" role="group" aria-label="${esc(c.pergunta)}"><p><strong>${esc(c.pergunta)}</strong></p><p class="porque">${esc(c.porque)}</p>
    <div class="botoes">${[['sim', 'Sim'], ['nao', 'Não'], ['', 'Não sei']].map(([v, l]) => `<button type="button" data-resp="${esc(c.id)}" data-v="${v}" aria-pressed="${(st.respostas[c.id] || '') === v}">${l}</button>`).join('')}</div></div>`).join('')}</div>`;
}

function enquadramentosHtml(r, sel) {
  if (!r.enquadramentos.length) return '';
  return `<div class="alt"><h3>Enquadramentos encontrados para ${fmtData(r.entrada.data)}</h3>
    <p class="nota">Toque num enquadramento para ver a simulação e o XML dele. A escolha não muda o diagnóstico.</p>
    <div class="opcoes">${r.enquadramentos.map(e => `<button type="button" class="opcao ${e.estado}" data-c="${e.cClassTrib}" aria-pressed="${sel && sel.cClassTrib === e.cClassTrib}">
      <span class="cc">${e.cClassTrib}</span>
      <span><span class="reg">${esc(e.regime)}</span> · CST ${e.cst}<span class="estado-e ${e.estado}">${estadoE[e.estado]}</span></span>
      <span class="q">${esc(e.desc)}${urlSegura(e.url) ? ` · <a href="${esc(urlSegura(e.url) || '#')}" target="_blank" rel="noopener">LC 214/2025, ${esc(e.art || '')}</a>` : ''}</span>
      ${e.condicoes.length ? `<span class="q">Condição: ${e.condicoes.map(c => `${esc(c.pergunta)} ${c.exige === 'nao' ? '(precisa ser não)' : ''} → ${c.resposta ? (c.resposta === 'sim' ? 'sim' : 'não') : 'sem resposta'}`).join(' ')}</span>` : ''}
      ${e.itens.length ? `<details><summary>Texto do item ${e.itens.map(i => esc(i.item)).join(' e ')} do anexo</summary>${e.itens.map(i => `<p class="u-my4 nota">${esc(i.item)}: ${esc(i.texto)}</p>`).join('')}</details>` : ''}
      <span class="fonte">Fonte: ${esc(e.fonte)}</span></button>`).join('')}</div></div>`;
}

function simulacao(e) {
  if (!e) return `<section class="painel" aria-labelledby="h-sim"><h2 id="h-sim">Simulação do imposto</h2><p class="nota">Sem enquadramento escolhido. A simulação aparece quando houver um enquadramento confirmado ou quando você escolher um na lista. A base não presume tributação integral.</p></section>`;
  const a = ANOS[st.ano];
  const lin = [['CBS', a.CBS, e.red.CBS || 0], ['IBS estadual', a.UF, e.red.IBSUF || 0], ['IBS municipal', a.MUN, e.red.IBSMun || 0]].map(([n, p, red]) => {
    const ef = e.cst === '200' || e.cst === '515' ? p * (1 - red / 100) : p; return {n, p, ef, v: Math.round(st.base * ef) / 100};
  });
  const tot = lin.reduce((s, l) => s + l.v, 0);
  return `<section class="painel" aria-labelledby="h-sim">
    <h2 id="h-sim">Simulação do imposto</h2>
    <p class="u-subt nota">Enquadramento ${e.cClassTrib}, ${esc(e.regime.toLowerCase())}.</p>
    <div class="controles">
      <div><span class="rot" id="rot-ano">Ano</span><div class="seg" role="group" aria-labelledby="rot-ano">${Object.keys(ANOS).map(y => `<button type="button" data-ano="${y}" aria-pressed="${+y === st.ano}">${y}</button>`).join('')}</div></div>
      <div><label class="rot" for="b">Base em R$</label><input id="b" inputmode="decimal" value="${fmt(st.base)}"></div>
    </div>
    <table><caption class="sr">Simulação para ${st.ano}</caption><thead><tr><th>Tributo</th><th class="n">Alíquota</th><th class="n">Efetiva</th><th class="n">Valor</th></tr></thead><tbody>
      ${lin.map(l => `<tr><td>${l.n}</td><td class="n">${fmt(l.p)}%</td><td class="n">${fmt(l.ef)}%</td><td class="n">R$ ${fmt(l.v)}</td></tr>`).join('')}
      <tr class="tot"><td>IBS + CBS em ${st.ano}</td><td></td><td></td><td class="n">R$ ${fmt(tot)}</td></tr></tbody></table>
    <p class="nota">${a.nota}</p>
  </section>`;
}

function xmlPainel(r, e) {
  const a = ANOS[st.ano];
  const valores = e ? {vBC: st.base, pIBSUF: a.UF, pIBSMun: a.MUN, pCBS: a.CBS} : null;
  const x = previaXml(B, r, e, valores);
  const confirmado = e && r.escolhido && r.escolhido.cClassTrib === e.cClassTrib && r.situacao !== 'confirmar';
  return `<section class="painel" aria-labelledby="h-xml">
    <h2 id="h-xml">XML da NF-e</h2>
    <pre id="xml" tabindex="0" aria-label="Trecho do XML do grupo IBSCBS">${esc(x.texto)}</pre>
    <div class="xmlacoes"><button type="button" id="cp">Copiar XML</button><span class="nota" id="cpmsg" role="status"></span></div>
    <p class="nota">Grupo IBSCBS do item (NT 2025.002); os grupos exigidos seguem o CST na tabela oficial.${e ? ` Valores numéricos da simulação de ${st.ano}.` : ''}${e && !confirmado ? ' Atenção: este enquadramento ainda não está confirmado para o produto.' : ''}</p>
    ${x.pendentes.length ? `<details><summary class="nota">${x.pendentes.length} campo${x.pendentes.length > 1 ? 's' : ''} marcado${x.pendentes.length > 1 ? 's' : ''} como [PENDENTE]</summary><ul class="pendentes">${[...new Set(x.pendentes)].map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
  </section>`;
}

function renderConsulta() {
  if (st.modo !== 'consulta') return;
  if (!st.code) return vazio();
  const r = analisar(B, {ncm: st.code, data: st.data, operacao: st.op, respostas: st.respostas, cst: st.cad?.cst, cClassTrib: st.cad?.ct});
  if (!r.produto) {
    const a = r.achados.find(x => x.codigo.startsWith('ncm_')) || r.achados[0];
    return erro(a.motivo, a.acao);
  }
  const sel = r.enquadramentos.find(e => e.cClassTrib === st.sel) || r.escolhido || null;
  const p = r.produto.caminho, cap = p.find(x => x[0].length === 2), pos = p.find(x => x[0].length === 4);
  const op = B.ops[r.entrada.operacao];
  const cod = r.escolhido;
  $('#res').innerHTML = `
  <article class="ficha" aria-labelledby="h-prod">
    <div class="ident">
      <h2 id="h-prod">${esc(r.produto.descricao)}</h2>
      <div class="ncmlinha"><span>NCM <span class="cod">${fmtNcm(st.code)}</span></span><button type="button" class="mini" id="cpncm" aria-label="Copiar o NCM ${fmtNcm(st.code)}">Copiar NCM</button></div>
      ${cap ? `<p class="cap">Capítulo ${cap[0]}: ${esc(cap[1])}${pos ? `<br>Posição ${fmtNcm(pos[0])}: ${esc(pos[1])}` : ''}</p>` : ''}
      <div class="meta">${tag(r.situacao)}<span>${esc(op ? op.nome : r.entrada.operacaoRecebida)} em ${r.entrada.data ? fmtData(r.entrada.data) : 'data inválida'}</span><span>Consultado em ${hoje}</span></div>
      ${st.cad ? `<p class="nota">Conferindo o cadastro com CST <span class="mono">${esc(st.cad.cst || '—')}</span> e cClassTrib <span class="mono">${esc(st.cad.ct || '—')}</span>. <button type="button" class="mini" id="semcad">Consultar sem os códigos do cadastro</button></p>` : ''}
    </div>
    <hr class="divisoria">
    <dl class="codigos">
      <div><dt>CST IBS/CBS ${cod ? '' : '(a confirmar)'}</dt><dd>${cod ? cod.cst : '—'}</dd></div>
      <div><dt>cClassTrib ${cod ? '' : '(a confirmar)'}</dt><dd>${cod ? cod.cClassTrib : '—'}</dd></div>
    </dl>
    ${r.semRegra ? `<p class="u-mt14 semregra">${SEM_REGRA}</p>` : ''}
    <div class="leitura">
      <div><h3>Diagnóstico</h3>${achadosHtml(r)}</div>
      ${cod ? `<div><h3>Quando se aplica</h3><p>${esc(cod.desc)}</p></div><div><h3>Base legal</h3><p>${urlSegura(cod.url) ? `<a href="${esc(urlSegura(cod.url))}" target="_blank" rel="noopener">LC 214/2025, ${esc(cod.art || '')}</a>` : esc(cod.art || '')}${cod.itens.length ? `, Anexo ${cod.itens.map(i => esc(i.item)).join(' e ')}` : ''}</p></div>` : ''}
    </div>
    ${perguntasHtml(r)}
    ${r.lacuna ? `<div class="obs"><strong>${esc(r.lacuna.titulo)}.</strong> ${esc(r.lacuna.porque)}<br><strong>Confirme:</strong> ${esc(r.lacuna.pergunta)}<br>${r.lacuna.classTrib.map(c => `<span class="mono">${c.cClassTrib}</span> ${esc(c.nome)} (<a href="${esc(urlSegura(c.url) || '#')}" target="_blank" rel="noopener">LC 214/2025, ${esc(c.art)}</a>)`).join('<br>')}</div>` : ''}
    ${r.avisos.map(a => `<div class="obs"><strong>Imposto Seletivo:</strong> ${esc(a)}</div>`).join('')}
    ${enquadramentosHtml(r, sel)}
  </article>
  <div class="paineis">${simulacao(sel)}${xmlPainel(r, sel)}</div>`;
}

function go(code, push = true) {
  st.code = code.replace(/\D/g, ''); st.sel = null; st.respostas = {};
  if (push) { try { history.replaceState(null, '', '#ncm-' + st.code); } catch (e) {} }
  $('#q').value = fmtNcm(st.code); hideSug(); renderConsulta();
}

let sugIdx = -1, sugList = [];
function hideSug() { $('#sug').style.display = 'none'; sugIdx = -1; $('#q').setAttribute('aria-expanded', 'false'); }
function suggest(v, show = true) {
  const words = norm(v).split(/\s+/).filter(w => w.length > 1), digits = v.replace(/\D/g, '');
  if (!words.length && digits.length < 2) { sugList = []; return hideSug(); }
  if (/^[\d.\s]+$/.test(v.trim())) sugList = IDX.filter(x => x.c.startsWith(digits)).slice(0, 20);
  else sugList = IDX.filter(x => words.every(w => x.t.includes(w))).sort((a, b) => words.every(w => b.l.includes(w)) - words.every(w => a.l.includes(w))).slice(0, 25);
  if (!show) return;
  const s = $('#sug');
  s.innerHTML = sugList.length ? sugList.map((x, i) => `<button type="button" role="option" data-i="${i}"><b>${fmtNcm(x.c)}</b>${esc(x.d)}<small>${esc(x.p)}</small></button>`).join('') : `<p class="vazio">Nenhum produto encontrado para “${esc(v.trim())}”. Tente um termo mais curto, como “soja” ou “parafuso”, ou digite o NCM.</p>`;
  s.style.display = 'block'; sugIdx = -1; $('#q').setAttribute('aria-expanded', 'true');
}
$('#q').addEventListener('input', e => suggest(e.target.value));
$('#q').addEventListener('keydown', e => {
  const btns = [...$('#sug').querySelectorAll('button')];
  if (e.key === 'Escape') return hideSug();
  if (!btns.length || $('#sug').style.display === 'none') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns.forEach((b, i) => b.classList.toggle('on', i === sugIdx)); btns[sugIdx].scrollIntoView({block: 'nearest'});
  } else if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); go(sugList[sugIdx].c); }
});
$('#sug').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { st.cad = null; go(sugList[+b.dataset.i].c); } });
document.addEventListener('click', e => { if (!e.target.closest('.busca')) hideSug(); });
$('#f').addEventListener('submit', e => {
  e.preventDefault(); const v = $('#q').value.trim();
  if (!v || !B) return;
  st.cad = null;
  if (/^[\d.\s-]+$/.test(v)) return go(v);
  suggest(v, false);
  if (sugList.length === 1) go(sugList[0].c); else suggest(v);
});
$('#ex').addEventListener('click', e => { const b = e.target.closest('button[data-c]'); if (b) { st.cad = null; go(b.dataset.c); } });
$('#dt').addEventListener('change', e => { st.data = e.target.value || hojeIso; renderConsulta(); });
$('#op').addEventListener('change', e => { st.op = e.target.value; ajudaOp(); renderConsulta(); });
function ajudaOp() { const o = B && B.ops[st.op]; $('#opajuda').textContent = o ? o.ajuda || '' : ''; }

function copiar(texto, alvo, ok) {
  const fim = m => { alvo.textContent = m; };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(() => fim(ok), () => fim('Não foi possível copiar. Selecione o texto e copie.'));
  else fim('Não foi possível copiar. Selecione o texto e copie.');
}
$('#res').addEventListener('click', e => {
  const a = e.target.closest('[data-ano]'); if (a) { st.ano = +a.dataset.ano; save(); renderConsulta(); $(`[data-ano="${st.ano}"]`)?.focus(); return; }
  if (e.target.closest('#cp')) return copiar($('#xml').textContent, $('#cpmsg'), 'Copiado');
  if (e.target.closest('#cpncm')) return copiar(st.code, $('#cpncm'), 'NCM copiado');
  if (e.target.closest('#semcad')) { st.cad = null; return renderConsulta(); }
  const rb = e.target.closest('[data-resp]');
  if (rb) { if (rb.dataset.v) st.respostas[rb.dataset.resp] = rb.dataset.v; else delete st.respostas[rb.dataset.resp]; renderConsulta(); $(`[data-resp="${rb.dataset.resp}"][data-v="${rb.dataset.v}"]`)?.focus(); return; }
  if (e.target.closest('summary,details,a')) return;
  const r = e.target.closest('.opcao[data-c]'); if (r) { st.sel = r.dataset.c; renderConsulta(); $(`.opcao[data-c="${st.sel}"]`)?.focus(); }
});
$('#res').addEventListener('change', e => {
  if (e.target.id === 'b') { const v = parseFloat(e.target.value.replace(/\./g, '').replace(',', '.')); if (v >= 0) { st.base = v; save(); } renderConsulta(); }
});

// ================= auditoria =================
const aud = {nome: '', demo: false, csv: null, mapa: null, lote: {data: hojeIso, operacao: 'venda'}, res: null, filtro: 'todos', aberto: new Set(), msg: ''};

function opcoesOp(sel, vazio) {
  return (vazio ? `<option value="">${vazio}</option>` : '') + Object.entries(B.ops).map(([k, o]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(o.nome)}${o.semCobertura ? ' (ainda não analisada)' : ''}</option>`).join('');
}

function renderAuditoria() {
  const el = $('#aud');
  const passo1 = `<section class="painel passo" aria-labelledby="h-p1">
    <h2 id="h-p1">Importar o cadastro</h2>
    <p class="nota">Exporte do ERP um CSV (até 20 MB) com SKU, descrição, NCM, CST IBS/CBS, cClassTrib e, se tiver, operação e data. Vírgula ou ponto e vírgula; o arquivo é lido no seu navegador e não é enviado para nenhum servidor. Linhas sem CST e cClassTrib também são analisadas.</p>
    <div class="arquivo">
      <label class="sr" for="arq">Arquivo CSV do cadastro</label><input type="file" id="arq" accept=".csv,text/csv,text/plain">
      <button type="button" id="demo">Usar cadastro de demonstração</button>
      <a href="exemplos/cadastro-demonstracao.csv" download>Baixar CSV de exemplo</a>
    </div>
    ${aud.msg ? `<p class="u-alerta estado erro" role="alert">${esc(aud.msg)}</p>` : ''}
  </section>`;
  let passo2 = '', passo3 = '';
  if (aud.csv) {
    const c = aud.csv;
    passo2 = `<section class="painel passo" aria-labelledby="h-p2">
      <h2 id="h-p2">Conferir colunas e contexto</h2>
      <p class="nota">${aud.demo ? '<strong>Cadastro fictício de demonstração.</strong> ' : ''}Arquivo <span class="mono">${esc(aud.nome)}</span>: ${c.registros.length} linha${c.registros.length !== 1 ? 's' : ''} de dados, separador “${c.delimitador === ';' ? 'ponto e vírgula' : 'vírgula'}”.</p>
      <div class="mapa">${COLUNAS.map(([k, nome]) => `<div><label for="map-${k}">${nome}${k === 'ncm' ? ' (obrigatória)' : ''}</label><select id="map-${k}" data-map="${k}"><option value="-1">Não tem no arquivo</option>${c.cabecalho.map((h, i) => `<option value="${i}" ${aud.mapa[k] === i ? 'selected' : ''}>${esc(h || `Coluna ${i + 1}`)}</option>`).join('')}</select></div>`).join('')}</div>
      <h3 class="u-h4">Para todo o lote</h3>
      <p class="u-mb6 nota">Valem para as linhas do arquivo que não trazem o tipo de venda ou a data.</p>
      <div class="lote"><div><label for="lote-data">Data de emissão da nota</label><input type="date" id="lote-data" value="${aud.lote.data}"></div>
        <div><label for="lote-op">Para quem você está vendendo?</label><select id="lote-op" aria-describedby="lote-op-ajuda">${opcoesOp(aud.lote.operacao)}</select><p class="u-mt4 nota" id="lote-op-ajuda">${esc(B.ops[aud.lote.operacao]?.ajuda || '')}</p></div></div>
      <h3 class="u-h4b">Amostra do arquivo</h3>
      <div class="tabela"><table><thead><tr><th>Linha</th>${c.cabecalho.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
        ${c.registros.slice(0, 5).map(r => `<tr><td class="cod">${r.linha}</td>${c.cabecalho.map((_, i) => `<td class="cod">${esc(r.campos[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="exportar"><button type="button" class="botao-pri" id="analisar" ${aud.mapa.ncm < 0 ? 'disabled' : ''}>Analisar cadastro</button>${aud.mapa.ncm < 0 ? '<span class="nota">Escolha a coluna do NCM para continuar.</span>' : ''}</div>
    </section>`;
  }
  if (aud.res) {
    const tot = Object.fromEntries(ORDEM.map(k => [k, 0]));
    for (const x of aud.res) tot[x.r.situacao]++;
    const lista = aud.res.filter(x => aud.filtro === 'todos' || x.r.situacao === aud.filtro);
    passo3 = `<section class="painel passo" aria-labelledby="h-p3">
      <h2 id="h-p3">Resultado da auditoria</h2>
      <p class="nota">${aud.res.length} itens analisados${aud.demo ? ' (cadastro fictício de demonstração)' : ''}. Toque num total para ver os itens.</p>
      <div class="totais">${ORDEM.map(k => `<button type="button" class="total s-${k}" data-filtro="${k}" aria-pressed="${aud.filtro === k}"><b>${tot[k]}</b><span>${SITUACOES[k]}</span></button>`).join('')}</div>
      <div class="filtros" role="group" aria-label="Filtrar itens"><button type="button" data-filtro="todos" aria-pressed="${aud.filtro === 'todos'}">Todos (${aud.res.length})</button>${ORDEM.map(k => `<button type="button" data-filtro="${k}" aria-pressed="${aud.filtro === k}">${SITUACOES[k]} (${tot[k]})</button>`).join('')}</div>
      <div class="itens" id="lista" tabindex="-1">${lista.length ? lista.map(itemHtml).join('') : '<p class="nota">Nenhum item nesta situação.</p>'}</div>
      <div class="exportar"><button type="button" class="botao-pri" id="baixar">Baixar resultado em CSV</button><button type="button" id="copiarcsv">Copiar CSV</button><span class="nota" id="expmsg" role="status"></span></div>
      <p class="nota">O CSV traz a linha original do arquivo, SKU, NCM, os dados recebidos, situação, motivo, ação sugerida e referência usada.</p>
    </section>`;
  }
  el.innerHTML = `<div class="passos">${passo1}${passo2}${passo3}</div>`;
}

function itemHtml(x) {
  const {reg, r} = x, m = aud.mapa;
  const v = k => (m[k] >= 0 ? reg.campos[m[k]] ?? '' : '');
  const aberto = aud.aberto.has(reg.linha);
  const exp = linhaExportacao(reg, m, r);
  return `<div class="item"><button type="button" data-linha="${reg.linha}" aria-expanded="${aberto}">
      <span class="ln">L${reg.linha}</span>
      <span class="nm">${esc(v('descricao') || '(sem descrição)')}<small>SKU <span class="mono">${esc(v('sku') || '—')}</span> · NCM <span class="mono">${esc(v('ncm') || '—')}</span></small></span>
      ${tag(r.situacao)}</button>
    ${aberto ? `<div class="det">
      <dl><dt>Linha no arquivo</dt><dd class="mono">${reg.linha}</dd><dt>SKU</dt><dd class="mono">${esc(v('sku') || '—')}</dd><dt>NCM recebido</dt><dd class="mono">${esc(v('ncm') || '—')}</dd>
      <dt>CST recebido</dt><dd class="mono">${esc(v('cst') || '—')}</dd><dt>cClassTrib recebido</dt><dd class="mono">${esc(v('cClassTrib') || '—')}</dd>
      <dt>Operação</dt><dd>${esc(exp['Operação'] ? (B.ops[exp['Operação']]?.nome || exp['Operação']) : '—')}${v('operacao') ? '' : ' (do lote)'}</dd><dt>Data</dt><dd>${esc(exp['Data'] || '—')}${v('data') ? '' : ' (do lote)'}</dd></dl>
      ${achadosHtml(r)}
      ${r.pendencias.length ? `<p class="nota"><strong>Para confirmar:</strong> ${r.pendencias.map(p => esc(p.pergunta)).join(' ')}</p>` : ''}
      ${r.avisos.map(a => `<p class="nota">${esc(a)}</p>`).join('')}
      ${r.produto ? `<p class="u-mt10"><a href="#ncm-${r.entrada.ncm}" data-abrir="${reg.linha}">Abrir este item na consulta com os mesmos dados</a></p>` : ''}
    </div>` : ''}</div>`;
}

function carregarTexto(texto, nome, demo) {
  aud.msg = ''; aud.res = null; aud.aberto.clear(); aud.filtro = 'todos';
  const c = lerCSV(texto);
  if (!c.cabecalho.length || !c.registros.length) { aud.csv = null; aud.msg = `O arquivo ${nome} não tem linhas de dados. Confira se a primeira linha é o cabeçalho e se há produtos abaixo dela.`; return renderAuditoria(); }
  aud.csv = c; aud.nome = nome; aud.demo = demo; aud.mapa = sugerirMapeamento(c.cabecalho);
  renderAuditoria();
  $('#h-p2')?.scrollIntoView({block: 'start', behavior: 'smooth'});
}

function analisarLote() {
  aud.res = aud.csv.registros.map(reg => ({reg, r: analisarLinha(B, reg.campos, aud.mapa, aud.lote)}));
  const ordem = Object.fromEntries(ORDEM.map((k, i) => [k, i]));
  aud.res.sort((a, b) => ordem[a.r.situacao] - ordem[b.r.situacao] || a.reg.linha - b.reg.linha);
  aud.filtro = 'todos'; aud.aberto.clear();
  renderAuditoria();
  $('#h-p3')?.scrollIntoView({block: 'start', behavior: 'smooth'});
}

function csvResultado() {
  const linhas = [...aud.res].sort((a, b) => a.reg.linha - b.reg.linha).map(x => {
    const l = linhaExportacao(x.reg, aud.mapa, x.r);
    l['Operação'] = B.ops[l['Operação']]?.nome || l['Operação'];
    return l;
  });
  return escreverCSV(linhas, ';');
}

$('#aud').addEventListener('change', e => {
  if (e.target.id === 'arq' && e.target.files[0]) {
    const f = e.target.files[0];
    if (f.size > LIMITE_CSV) { aud.msg = `O arquivo ${f.name} tem ${(f.size / 1048576).toFixed(1).replace('.', ',')} MB. O limite é ${LIMITE_CSV / 1048576} MB: divida o cadastro em partes.`; aud.csv = null; aud.res = null; return renderAuditoria(); }
    f.text().then(t => carregarTexto(t, f.name, false), () => { aud.msg = 'Não foi possível ler o arquivo. Tente salvar como CSV (UTF-8) e importar de novo.'; renderAuditoria(); });
  }
  if (e.target.dataset.map) { aud.mapa[e.target.dataset.map] = +e.target.value; aud.res = null; renderAuditoria(); $(`#map-${e.target.dataset.map}`).focus(); }
  if (e.target.id === 'lote-data') { aud.lote.data = e.target.value; aud.res = null; }
  if (e.target.id === 'lote-op') { aud.lote.operacao = e.target.value; aud.res = null; $('#lote-op-ajuda').textContent = B.ops[aud.lote.operacao]?.ajuda || ''; }
});
$('#aud').addEventListener('click', e => {
  if (e.target.closest('#demo')) {
    fetch('exemplos/cadastro-demonstracao.csv').then(r => { if (!r.ok) throw 0; return r.text(); })
      .then(t => carregarTexto(t, 'cadastro-demonstracao.csv', true), () => { aud.msg = 'Não foi possível carregar o cadastro de demonstração.'; renderAuditoria(); });
    return;
  }
  if (e.target.closest('#analisar')) return analisarLote();
  const f = e.target.closest('[data-filtro]');
  if (f) { aud.filtro = f.dataset.filtro; renderAuditoria(); const alvo = f.classList.contains('total') ? $('#lista') : $(`.filtros [data-filtro="${aud.filtro}"]`); alvo?.focus(); if (f.classList.contains('total')) $('#lista').scrollIntoView({block: 'start', behavior: 'smooth'}); return; }
  const ab = e.target.closest('[data-abrir]');
  if (ab) {
    e.preventDefault();
    const x = aud.res.find(y => y.reg.linha === +ab.dataset.abrir), r = x.r;
    st.data = r.entrada.data || st.data; st.op = r.entrada.operacao || st.op;
    st.cad = {cst: r.entrada.cst, ct: r.entrada.cClassTrib};
    $('#dt').value = st.data; $('#op').value = st.op; ajudaOp();
    location.hash = '#ncm-' + r.entrada.ncm;
    return;
  }
  const it = e.target.closest('[data-linha]');
  if (it) { const n = +it.dataset.linha; aud.aberto.has(n) ? aud.aberto.delete(n) : aud.aberto.add(n); renderAuditoria(); $(`[data-linha="${n}"]`).focus(); return; }
  if (e.target.closest('#baixar')) {
    try {
      const blob = new Blob(['﻿' + csvResultado()], {type: 'text/csv;charset=utf-8'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = (aud.nome.replace(/\.csv$/i, '') || 'cadastro') + '-auditoria-ibs-cbs.csv';
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      $('#expmsg').textContent = 'Download iniciado. Se não começar, use “Copiar CSV”.';
    } catch (err) { $('#expmsg').textContent = 'O download foi bloqueado. Use “Copiar CSV”.'; }
    return;
  }
  if (e.target.closest('#copiarcsv')) return copiar(csvResultado(), $('#expmsg'), 'CSV copiado. Cole num editor de texto e salve como .csv.');
});

// ================= tabela cClassTrib =================
const tab = {q: '', cst: '', data: hojeIso};
function linhasTabela() {
  const q = norm(tab.q).trim();
  return tabelaClassTrib(B, tab.data).filter(l => (!tab.cst || l.CST === tab.cst) && (!q || norm(Object.values(l).join(' ')).includes(q)));
}
function renderTabela() {
  const todas = tabelaClassTrib(B, tab.data), ls = linhasTabela();
  const csts = [...new Set(todas.map(l => l.CST))];
  const red = l => [['CBS', 'Redução CBS (%)'], ['IBS', 'Redução IBS UF (%)']].filter(([, k]) => l[k] !== '').map(([n, k]) => `${n} ${String(l[k]).replace('.', ',')}%`).join(' · ') || '—';
  $('#tab').innerHTML = `<section class="painel" aria-labelledby="h-tab">
    <h2 id="h-tab">Tabela de classificação tributária (cClassTrib) do IBS e da CBS</h2>
    <p class="nota">IT 2025.002 ${esc(B.tab.versao)}, publicada em ${fmtData(B.D.versoes.tabelaPublicacao)}. Reduções vigentes na data escolhida. ${todas.length} códigos.</p>
    <div class="busca-tab">
      <div><label for="tq">Buscar</label><input type="search" id="tq" value="${esc(tab.q)}" placeholder="Código, nome, anexo ou artigo"></div>
      <div><label for="tcst">CST</label><select id="tcst"><option value="">Todos</option>${csts.map(c => `<option value="${c}" ${c === tab.cst ? 'selected' : ''}>${c} ${esc(B.D.cst[c]?.nome || '')}</option>`).join('')}</select></div>
      <div><label for="tdt">Vigência em</label><input type="date" id="tdt" value="${tab.data}"></div>
      <button type="button" class="botao-pri" id="tbaixar">Baixar planilha (${ls.length === todas.length ? 'tabela completa' : ls.length === 1 ? '1 código filtrado' : ls.length + ' códigos filtrados'})</button>
      <span class="nota" id="tmsg" role="status"></span>
    </div>
    <div class="tabela"><table class="tabct"><thead><tr><th>cClassTrib</th><th>CST</th><th>Nome</th><th>Redução</th><th>Base legal</th><th>Vigência</th><th>NF-e</th></tr></thead><tbody>
      ${ls.map(l => `<tr><td class="cod">${l.cClassTrib}</td><td class="cod">${l.CST}</td><td class="desc">${esc(l.Nome)}</td><td>${red(l)}</td><td>${urlSegura(l.Link) ? `<a href="${esc(urlSegura(l.Link))}" target="_blank" rel="noopener">${esc(l['Base legal'] || 'LC 214/2025')}</a>` : esc(l['Base legal'])}</td><td class="cod">${l['Início da vigência']}${l['Fim da vigência'] ? ' a ' + l['Fim da vigência'] : ' em diante'}</td><td>${l['Usado em NF-e'] || '—'}</td></tr>`).join('') || '<tr><td colspan="7">Nenhum código com esse filtro.</td></tr>'}
    </tbody></table></div>
    <p class="nota">A planilha sai em CSV com ponto e vírgula (abre no Excel e no Google Planilhas) e traz também a descrição completa, as reduções por tributo, os grupos do XML exigidos pelo CST e a data de publicação.</p>
  </section>`;
}
$('#tab').addEventListener('input', e => {
  if (e.target.id === 'tq') { tab.q = e.target.value; renderTabela(); const i = $('#tq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
});
$('#tab').addEventListener('change', e => {
  if (e.target.id === 'tcst') { tab.cst = e.target.value; renderTabela(); $('#tcst').focus(); }
  if (e.target.id === 'tdt') { tab.data = e.target.value || hojeIso; renderTabela(); $('#tdt').focus(); }
});
$('#tab').addEventListener('click', e => {
  if (!e.target.closest('#tbaixar')) return;
  try {
    const blob = new Blob(['﻿' + escreverCSV(linhasTabela(), ';')], {type: 'text/csv;charset=utf-8'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tabela-cclasstrib-ibs-cbs-${B.tab.versao || ''}.csv`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $('#tmsg').textContent = 'Download iniciado.';
  } catch (err) { $('#tmsg').textContent = 'O download foi bloqueado pelo navegador.'; }
});

// ================= navegação =================
function modo() {
  const h = location.hash;
  const m = h.match(/^#ncm-(\d{8})$/);
  st.modo = h === '#auditoria' ? 'auditoria' : h === '#tabela' ? 'tabela' : 'consulta';
  for (const m of ['consulta', 'auditoria', 'tabela']) {
    const a = $('#m-' + m);
    if (st.modo === m) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('#f').hidden = st.modo !== 'consulta';
  $('#res').hidden = st.modo !== 'consulta';
  $('#aud').hidden = st.modo !== 'auditoria';
  $('#tab').hidden = st.modo !== 'tabela';
  $('#sub').textContent = {consulta: 'Consulte o enquadramento fiscal de um produto pelo NCM ou pela descrição.',
    auditoria: 'Importe o cadastro de produtos do ERP e veja, item a item, o que revisar antes do go-live.',
    tabela: 'Todos os códigos de classificação tributária do IBS e da CBS, com vigência, base legal e download em planilha.'}[st.modo];
  if (!B) return;
  if (st.modo === 'auditoria') return renderAuditoria();
  if (st.modo === 'tabela') return renderTabela();
  if (m && m[1] !== st.code) go(m[1], false); else renderConsulta();
}
window.addEventListener('hashchange', modo);

$('#dt').value = st.data;
fetch('data.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
  B = criarBase(d);
  $('#op').innerHTML = opcoesOp(st.op); ajudaOp();
  IDX = d.ncm.map(([c, desc]) => {
    const p = caminho(B, c).map(x => x[1]), dd = strip(desc);
    return {c, d: dd, p: p.slice(-2).join(' / '), l: norm(dd + ' ' + (p[p.length - 1] || '')), t: norm(c + ' ' + p.join(' ') + ' ' + dd)};
  });
  const f = Object.fromEntries(d.fontes.map(x => [x.id, x]));
  $('#ver').innerHTML = `Regras NCM da Calculadora oficial da Receita (módulo offline ${esc(f['calculadora-offline-V0059'].versao)}, dados de ${fmtData(f['calculadora-offline-V0059'].data)}) e tabela cClassTrib do IT 2025.002 ${esc(f['it-2025.002-v1.60-cclasstrib'].versao)} (publicada em ${fmtData(d.versoes.tabelaPublicacao)}), pelo pacote aberto @sinete/ibs-cbs-dados e pelo serviço de consulta da SEFAZ. NCMs da tabela do Siscomex de ${fmtData(d.versoes.ncm.slice(0, 10))}. Cada regra tem início e fim de vigência; a análise usa a data da operação.`;
  modo();
  if (st.modo === 'consulta' && !st.code) $('#q').focus();
}).catch(() => { erro('As tabelas não carregaram. Verifique a conexão e recarregue a página.'); });
