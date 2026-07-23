// Testa o motor de breeding. Regras conferidas no bundle; casos de borda do Grok-3.
// Rode: node breeding-teste.js

const B = require('../breeding');
const ok = [], falha = [];
const t = (nome, cond, obs) => (cond ? ok : falha).push(nome + (obs ? ' -> ' + obs : ''));
const P = (especie, q, iv, extra) => Object.assign({ nome: 'X', especie, q, iv }, extra || {});

// ---- a regra central: IV vem do pai de MAIOR QUALIDADE, não do de maior IV ----
// Do box real do Frederico: Oddish Q1.8/IV121 e Oddish Q1.083/IV163.
const perfeito = P(43, 1.8, 121), iveiro = P(43, 1.083, 163);
// gap 0,717 > gapMaximo: não são elegíveis em breed normal — outra lição.
t('qualidades muito distantes nao cruzam', !B.elegivel(perfeito, iveiro).ok, B.elegivel(perfeito, iveiro).motivo);

// par elegível (gap pequeno): IV do de maior qualidade
const a = P(43, 1.60, 100), b = P(43, 1.50, 163);
const f = B.projetarFilho(a, b);
t('filho herda o IV do pai de maior qualidade', f.iv === 100, 'iv ' + f.iv);
t('o IV alto do outro pai e jogado fora', f.ivPerdido === 63, 'perdeu ' + f.ivPerdido);
// E[Δ] = 0,1875 sobre o melhor pai (1,60) -> 1,7875
t('qualidade = maior + E[delta] feromonio', Math.abs(f.qualidade - 1.7875) < 0.0001, 'q ' + f.qualidade);
// o teto é 2.6, não 1.8 — breeding passa da banda de captura
t('qualidade pode passar de 1.8', B.projetarFilho(P(1,1.9,100), P(1,1.85,100)).qualidade > 1.8);
t('qualidade nunca passa de 2.6', B.projetarFilho(P(1,2.55,100), P(1,2.5,100)).qualidade <= 2.6);

// ---- gap: same-species e Ditto ----
t('especies diferentes nao cruzam', !B.elegivel(P(43,1.5,100), P(44,1.5,100)).ok);
t('Ditto nao cruza', !B.elegivel(P(43,1.5,100,{ditto:true}), P(43,1.5,100)).ok);

// ---- caminho grátis rende ~20× menos ----
const fFer = B.projetarFilho(P(1,1.0,100), P(1,0.95,100), { caminho: 'feromonio' });
const fGra = B.projetarFilho(P(1,1.0,100), P(1,0.95,100), { caminho: 'gratis' });
t('gratis sobe muito menos que feromonio',
  (fFer.qualidade - 1.0) > 15 * (fGra.qualidade - 1.0), 'fer +' + (fFer.qualidade-1).toFixed(3) + ' vs gratis +' + (fGra.qualidade-1).toFixed(4));

// ---- shiny: conserva, e o parceiro precisa de qualidade minima ----
const shiny = B.projetarFilho(P(1,1.2,90,{shiny:true}), P(1,1.6,90));
t('um pai shiny -> filho shiny', shiny.shiny === true);
t('parceiro fraco demais para shiny e rejeitado', !B.elegivel(P(1,1.6,90,{shiny:true}), P(1,0.5,90)).ok,
  B.elegivel(P(1,1.6,90,{shiny:true}), P(1,0.5,90)).motivo);
t('shiny ignora a regra de gap', B.elegivel(P(1,1.8,90,{shiny:true}), P(1,1.05,90)).ok);

// ---- doubling stone soma a esperanca do +1 ----
const semD = B.projetarFilho(a, b, { doubling: false });
const comD = B.projetarFilho(a, b, { doubling: true });
t('doubling stone soma ~0,3 de IV', Math.abs((comD.iv - semD.iv) - 0.3) < 0.001, '+' + (comD.iv - semD.iv).toFixed(2));

// ---- empate de qualidade: pior caso (menor IV manda), determinístico ----
const e1 = B.projetarFilho(P(1,1.55,190), P(1,1.55,160));
const e2 = B.projetarFilho(P(1,1.55,160), P(1,1.55,190));
t('empate de qualidade assume o pior IV', e1.iv === 160 && e2.iv === 160, e1.iv + '/' + e2.iv);
t('empate e deterministico (mesma resposta trocando a ordem)', e1.iv === e2.iv);

// ---- ranking real: pedaço do box do Frederico ----
const box = [
  P(43, 1.8,   121), P(43, 1.752, 128), P(43, 1.60, 148), P(43, 1.55, 100),
  P(102, 1.771, 143, { leader: true }), P(102, 1.60, 116), P(102, 1.55, 103),
  P(19, 1.435, 105), P(19, 1.238, 118), P(19, 0.849, 81),
];
const top = B.melhoresPares(box, { limite: 6 });
t('produz ranking', top.length > 0, top.length + ' pares');
t('todo par e da mesma especie e elegivel', top.every(p => B.elegivel(p.portador, p.combustivel).ok));
t('ordena por quanto sobe o teto', top.every((p, i) => i === 0 || top[i-1].subiuTeto >= p.subiuTeto));
t('nao consome o leader por padrao', top.every(p => !p.portador.leader && !p.combustivel.leader));
t('um portador aparece uma vez', new Set(top.map(p => p.especie+':'+p.portador.iv+':'+p.portador.q)).size === top.length);

// ---- veredito honesto: nada supera o campeao ----
const boxTopo = [P(9, 2.6, 192), P(9, 2.59, 100)];  // campeão já no teto (2.6)
const rec = B.recomendacao(boxTopo);
t('nao recomenda quando nada sobe o teto', rec.temPar === false, rec.motivo);
t('box de 1 pokemon nao gera par', B.recomendacao([P(1,1,50)]).temPar === false);
t('box vazio nao quebra', B.recomendacao([]).temPar === false);

// ---- números degenerados não quebram ----
t('ignora pokemon sem qualidade/iv', (() => {
  try { B.melhoresPares([P(1,1.5,100), { nome:'lixo', especie:1 }, P(1,1.4,90)]); return true; }
  catch (e) { return false; }
})());

// ---- relatório ----
console.log('\n=== BREEDING ===');
for (const l of ok) console.log('  ok  ' + l);
for (const l of falha) console.log('  XX  ' + l);
if (top.length) {
  const m = top[0];
  console.log('\nmelhor cruzamento no box de exemplo:');
  console.log('  ' + m.nome + ' Q' + m.portador.q + '/IV' + m.portador.iv +
              '  +  Q' + m.combustivel.q + '/IV' + m.combustivel.iv + ' (combustível)' +
              '  ->  filho Q' + m.filho.qualidade + '/IV' + m.filho.iv +
              (m.filho.ivPerdido ? '  [perde ' + m.filho.ivPerdido + ' de IV]' : ''));
}
console.log('\n' + (falha.length ? 'HÁ FALHAS' : 'TUDO CERTO — ' + ok.length + ' testes'));
process.exit(falha.length ? 1 : 0);
