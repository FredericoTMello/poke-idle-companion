# Roadmap

Este documento é também um compromisso de conduta: além do que planejamos fazer, ele diz o que **decidimos não fazer**, para que a fronteira do projeto seja pública e verificável.

## A linha que não cruzamos

Todo item deste roadmap — feito, em andamento ou futuro — respeita, sem exceção:

- **Somente leitura.** Nada que envie ao servidor, automatize ou aja pelo jogador.
- **Com autorização.** A ferramenta opera sob permissão da equipe do jogo, e essa permissão vale para estudo/uso, não para distribuir automação.

Se um item algum dia exigisse quebrar isso, ele **não entra** — vira um "não faremos", abaixo.

## Feito

- **Coletor por WebSocket** — escuta passiva das mensagens do jogo, agregadas em memória local. Sem envio.
- **Medição de combate** — XP/s real, dano por golpe, ritmo de abate (descontando pausas do jogador).
- **Fórmula de dano, decifrada por medição** — `dano = K · ataque × (ataque ou spAtk) · poder · efetividade / defesa`. Físico usa ataque²; especial usa a média geométrica ataque×spAtk. Erro médio de ~4% fora dos regimes de borda.
- **Regra de escolha de golpe** — o jogo escolhe por maior dano esperado contra cada alvo; o que parecia "alternância" é quase-empate resolvido pelos atributos individuais.
- **Recomendação de caça** — melhores alvos por XP/s, filtrando por nível de acesso e sobrevivência.
- **Aviso de overkill** e barra de progresso até o próximo nível.
- **Motor de breeding** — projeção do filho, ranking de pares, com a mecânica lida do jogo (mesma espécie, IV do pai de maior qualidade, Δ de qualidade, gap ≤ 0,15, teto 2,6).
- **Resumo de sessão** copiável para o chat.

## Em andamento

- **Painel de breeding** — a interface do planejador (o motor já existe e é testado).
- **Estudo de shiny** — a coleta já roda; falta acumular amostra para medir a taxa real e testar se as aparições são aleatórias ou têm compensação.

## Backlog

- Modelo de tempo de respawn por mapa (hoje usamos o ritmo medido, que só cobre alvos já visitados).
- Planejador de evolução (vale evoluir agora ou segurar?).
- Refinar dois números do breeding ainda estimados (qualidade mínima do parceiro shiny; custo em pedras por rota).

## Decidimos NÃO fazer

Estes ficam fora **por princípio**, não por falta de tempo:

- **Qualquer automação** — auto-caça, auto-captura, auto-breeding, macros. A extensão nunca executará uma ação no jogo.
- **Envio ao servidor** — a ferramenta nunca mandará um pacote ao jogo. É leitura e só.
- **Executar o breeding pelo jogador** — o planejador recomenda; o cruzamento é feito por você, na tela do jogo.
- **Captura de preço de mercado** — investigamos: o preço não trafega pelo WebSocket, e não vamos interceptar chamadas de rede para obtê-lo.
- **Coletar ou transmitir dados de outros jogadores** — só lemos o que é seu, e nada sai do seu navegador.

## Contribuindo

Achou algo que contradiz os princípios acima? Isso é o bug mais importante que existe aqui — abra uma issue. Sugestões de features são bem-vindas desde que caibam na linha que não cruzamos.
