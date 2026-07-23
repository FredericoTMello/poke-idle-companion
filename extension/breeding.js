// PIW — Motor de Breeding
//
// Puro: sem DOM, sem socket. Recebe o box (pokémons coletados) e devolve o
// ranking de cruzamentos. Testável por Node e reusado pelo painel.
//
// REGRAS, todas conferidas LITERALMENTE no bundle do jogo (2pg3y7crx2v4i.js):
//   "Same species, straight from your box"                    -> só cruza mesma espécie
//   "Ditto cannot breed."                                     -> Ditto fora
//   "The child gets the IV of the HIGHER-quality parent"      -> IV vem do pai de maior qualidade
//   "Without doubling stones the IV doesn't change"           -> breeding NÃO fabrica IV
//   "Doubling gives a 5% chance of +1 on a stat" (custa 2×)   -> E[+IV] = 0,05 × (stats < 32)
//   "Child quality = BEST parent + Δ"                         -> qualidade = melhor pai + Δ
//   "Pheromones ... +0.15 to +0.30 quality"                   -> Δ feromônio na faixa
//   "Free path ... Δ ~20× smaller"                            -> caminho grátis rende ~1/20
//   "normal breeds require a gap ≤ {{max}}"                   -> gap de qualidade limita o par
//   "with a shiny parent there is no quality gap rule"        -> pai shiny remove o limite de gap
//   "One shiny parent → the baby is ALWAYS shiny"             -> shiny se conserva
//   "Two normal parents never mint a shiny"                   -> dois normais nunca geram shiny
//
// A GRANDE consequência: breeding NÃO combina genes. O filho é uma CÓPIA do pai
// de maior qualidade, com a qualidade +Δ. O segundo pai só serve para: (1) ser
// consumido, (2) passar shiny. Logo breeding LAVA QUALIDADE — não cria IV.
// IV alto só vem de captura. (Insight do agente de decisão, 22/07.)
//
// INCÓGNITAS deixadas como parâmetros (o jogo mostra {{max}}/{{min}} mas o número
// não está no bundle — a confirmar medindo no jogo):
const REGRAS = {
  IV_MAX: 192,           // 6 atributos × 32
  // O teto de qualidade é 2.6, NÃO 1.8. O 1.8 é só a melhor banda de CAPTURA;
  // breeding empurra além (a tela mostra "teto 2.6" e projeta filho até 1.88).
  Q_MAX: 2.6,
  // Distribuição do Δ de qualidade, lida da tela do jogo. E[Δ] = 0,1875.
  // NÃO é o meio da faixa — 50% das vezes sai o mínimo.
  deltaDist: [[0.15, 0.50], [0.20, 0.30], [0.25, 0.15], [0.30, 0.05]],
  deltaFeromonio: 0.1875,      // esperança da distribuição acima
  deltaGratis: 0.1875 / 20,    // "~20× menor" (confirmado na tela)
  gapMaximo: 0.15,       // |qA − qB| permitido em breed normal — CONFIRMADO na tela do jogo
  qMinParceiroShiny: 1.0, // parceiro de um shiny precisa de qualidade ≥ isto — A CONFIRMAR ({{min}})
  ganhoIVdoubling: 6 * 0.05, // teto do +1 a 5% em 6 atributos (menos se já no teto)
  // Custos reais (tela): feromônio = 9 Strange Pheromone; doubling = 20 Punch
  // Stones + $2.000.000; choco grátis = 3.000 derrotas em hunt.
  custoFeromonio: { strangePheromone: 9 },
  custoDoubling: { punchStone: 20, dinheiro: 2000000 },
  chocoDerrotas: 3000,
};

(function (raiz) {
  'use strict';

  const R = REGRAS;

  // Um par é elegível? Devolve {ok} ou {ok:false, motivo}.
  function elegivel(a, b) {
    if (a.especie !== b.especie) return { ok: false, motivo: 'espécies diferentes' };
    if (a.ditto || b.ditto) return { ok: false, motivo: 'Ditto não cruza' };
    const temShiny = a.shiny || b.shiny;
    if (temShiny) {
      // Com shiny não há regra de gap, mas o parceiro precisa de qualidade mínima.
      const parceiro = a.shiny ? b : a;
      if (parceiro.q < R.qMinParceiroShiny) return { ok: false, motivo: 'parceiro fraco demais para o shiny' };
    } else if (Math.abs(a.q - b.q) > R.gapMaximo) {
      return { ok: false, motivo: 'qualidades distantes demais' };
    }
    return { ok: true };
  }

  // Projeta o filho de um cruzamento já elegível. Só aplica as regras.
  function projetarFilho(a, b, opts) {
    opts = opts || {};
    const caminho = opts.caminho || 'feromonio';
    const doubling = !!opts.doubling;
    const delta = caminho === 'gratis' ? R.deltaGratis : R.deltaFeromonio;

    // Pai de MAIOR qualidade manda no IV. Empate: assumimos o de MENOR IV — o
    // jogo não documenta o desempate, então relatamos o pior caso (Grok-3, caso 10).
    const melhor = (b.q > a.q || (b.q === a.q && b.iv < a.iv)) ? b : a;

    return {
      qualidade: +Math.min(R.Q_MAX, melhor.q + delta).toFixed(4),
      iv: +Math.min(R.IV_MAX, melhor.iv + (doubling ? R.ganhoIVdoubling : 0)).toFixed(2),
      herdouDe: melhor,
      shiny: !!(a.shiny || b.shiny),
      // O IV do outro pai é ignorado. Se ele era melhor, foi jogado fora —
      // é o erro que o jogo esconde e a ferramenta expõe.
      ivPerdido: Math.max(a.iv, b.iv) - melhor.iv,
      // Δ desperdiçado por bater no teto de qualidade.
      deltaPerdido: +Math.max(0, (melhor.q + delta) - R.Q_MAX).toFixed(4),
    };
  }

  // Utilidade de um pokémon: qualidade + IV normalizado (+ bônus shiny).
  // Aceita tanto membro do box (.q) quanto filho projetado (.qualidade).
  function U(p) {
    const q = p.q != null ? p.q : p.qualidade;
    return q + p.iv / R.IV_MAX + (p.shiny ? 0.3 : 0);
  }

  // Ranking de cruzamentos. A jogada certa (Opus): para cada PORTADOR (o gene
  // que você quer preservar), o melhor COMBUSTÍVEL é o de menor utilidade que
  // ainda forma par elegível — assim você sobe o teto do box queimando o mínimo.
  function melhoresPares(box, opts) {
    opts = opts || {};
    const limite = opts.limite || 6;
    const protege = opts.evitarLeader !== false;

    const porEsp = {};
    for (const p of box) {
      if (!p || typeof p.q !== 'number' || typeof p.iv !== 'number') continue;
      (porEsp[p.especie] = porEsp[p.especie] || []).push(p);
    }

    const linhas = [];
    for (const esp in porEsp) {
      const membros = porEsp[esp].filter(p => !(protege && p.leader) && !p.ditto);
      if (membros.length < 2) continue;
      const campeao = Math.max.apply(null, membros.map(U));

      for (const portador of membros) {
        // melhor combustível: menor U que forma par elegível com o portador
        let comb = null;
        for (const c of membros) {
          if (c === portador) continue;
          if (!elegivel(portador, c).ok) continue;
          if (!comb || U(c) < U(comb)) comb = c;
        }
        if (!comb) continue;
        const filho = projetarFilho(portador, comb, opts);
        linhas.push({
          especie: +esp, nome: portador.nome, portador, combustivel: comb, filho,
          ganhoLiquido: +(U(filho) - U(portador) - U(comb)).toFixed(4),
          subiuTeto: +(U(filho) - campeao).toFixed(4),
          // desperdício: o filho não supera o melhor dos dois pais consumidos
          desperdicio: U(filho) <= Math.max(U(portador), U(comb)) + 1e-9,
        });
      }
    }

    // ordena por quanto SOBE O TETO do box; empate, pelo que queima menos
    linhas.sort((x, y) => (y.subiuTeto - x.subiuTeto) || (U(x.combustivel) - U(y.combustivel)));
    // dedup: um portador aparece uma vez (seu melhor combustível)
    const visto = new Set(), unicos = [];
    for (const l of linhas) {
      const k = l.especie + ':' + l.portador.iv + ':' + l.portador.q;
      if (visto.has(k)) continue;
      visto.add(k); unicos.push(l);
    }
    return unicos.slice(0, limite);
  }

  // A pergunta direta: vale cruzar alguma coisa agora?
  function recomendacao(box, opts) {
    const top = melhoresPares(box, opts);
    if (!top.length) return { temPar: false, motivo: 'sem dois da mesma espécie que possam cruzar' };
    if (top[0].subiuTeto <= 0) {
      // Nada sobe o teto. Se o campeão já está no IV máximo do box, o gargalo é IV.
      return { temPar: false, motivo: 'nenhum cruzamento supera o que você já tem — para subir IV, capture', melhorAinda: top[0] };
    }
    return { temPar: true, melhor: top[0], alternativas: top.slice(1) };
  }

  const api = { elegivel, projetarFilho, melhoresPares, recomendacao, U, REGRAS: R };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.PIWBreeding = api;
})(typeof window !== 'undefined' ? window : this);
