# Preflight da prova local Pi/Claude — sem inferência

Registro histórico do preflight, anterior à inferência. Estado atual da campanha:
[Prova local Pi/Claude — síntese](harness-proof-summary.md); chamadas encerradas no teto de 20.
Ticket: [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md).

## Autorização recebida

Operador aprovou ambiente local descartável, 60 minutos de execução real, até 20 ativações,
um Builder e até dois revisores, sem repetição automática, parada por violação/limite/perda de controle
e cleanup próprio. Escolheu OpenAI `gpt-6-luna` no Pi. Isso não identifica por si só assinatura versus
API paga. Não foi presumido teto monetário nem fallback.

## Fatos observados somente por leitura

- Destino documental: main no checkout principal, inicialmente `0a8b9c61eaf8cb9fd62c3e5a3a9ae6c8c94221be`.
- Worktree própria: `.worktrees/harness-proof-run/`, branch `prototype/v2-harness-proof`.
- SHA MVP imutável ainda existe: `aabe06abfb20e83593020c0fee19b078d235466b`.
- Integração MVP existente avançou para `7cf1adc` (prefixo observado); não se adotou código desse
  commit como referência da prova nem se modificou sua worktree. Seu package.json foi consultado
  somente para inventariar dependências declaradas, não demonstrar instalação/funcionamento.
- Node `24.21.0`, npm `11.19.0` por comandos de versão.
- Caminho do executável Claude resolve para diretório de versão `2.1.325`; isso é indício de versão,
  não versão efetiva já confirmada por execução do binário.
- Pi global: pacote `@earendil-works/pi-coding-agent` `1.5.2` por leitura de package.json.
- Agent SDK `@anthropic-ai/claude-agent-sdk` não encontrado no node_modules da integração MVP
  inspecionada. `@anthropic-ai/sdk` `0.129.0` presente é Client SDK, não o Agent SDK exigido.
- Pacote Gondolin não localizado nos caminhos de pacote inspecionados; `/dev/kvm` e diretório
  cache Gondolin existem, mas não comprovam runtime/imagem/perfil funcionais. Nenhuma VM iniciada.
- Variável `ANTHROPIC_API_KEY` presente no ambiente; somente o nome/presença foi observado,
  valor não lido nem registrado. Execução por assinatura deve excluir essa herança para evitar
  modalidade API inadvertida; nenhuma chamada a modelo foi feita.

## Fontes oficiais relidas

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): binário inalterado,
  autenticação própria do usuário e restrições contra intermediação. Não inferir permissão geral de produto.
- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview): SDK executa o harness
  Claude; mantém ressalva para terceiros oferecerem login/limites Claude.ai em produtos.
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):
  diferencia assinatura de API key/credits; assinado com plano continua consumindo limites do plano.

Essas leituras são verificação documental do experimento próprio do Operador, não parecer jurídico
nem autorização para oferta a terceiros. Instalação do SDK não foi feita, credenciais não foram usadas,
login não foi executado, modelos não foram chamados e recursos externos não foram provisionados.

## Atualização após autorização adicional

O Operador confirmou OpenAI por assinatura/OAuth oficial e instalação de dependências locais,
ressaltando Claude exclusivamente por subscription, não API. Sem cobrança API ou fallback.

- Instalado Agent SDK `0.3.325` e zod `4.6.7` em `.runtime/harness/`, com versões exatas e
  install scripts desabilitados. Dependências do snapshot instaladas por `npm ci --ignore-scripts`
  exclusivamente em `.runtime/mvp/`. npm reportou cinco vulnerabilidades moderadas no snapshot;
  não foi feito audit fix nem atualização implícita do lockfile de referência.
- Snapshot copiado por git archive do SHA fixado, sem edição de código fonte. Build inicial falhou
  por declarações do SDK staged ainda ausentes. Preparo tentou aplicar patches em cópia aninhada
  ao repositório pai e acusou SDK_PATCH_DRIFT; dez hashes eram os originais, indicando patches não
  aplicados. Inicializar Git somente no diretório descartável e recriar seu staging resolveu o preparo,
  sem mudar patches/hashes/código: Pi e Gondolin staged passaram seus verificadores de integridade.
- Perfis preparados: `factory-development-pi-1.5.2-read-async-bash-lexical-v3` e
  `factory-development-gondolin-0.14.0-stdin-capacity-v1`. Não são evidência de VM ou jornada real.
- Typecheck posterior foi iniciado, mas excedeu o timeout de 120 segundos do comando conjunto;
  não registrar como aprovado. Nenhuma suíte de runtime ou jornada foi executada.
- Claude auth help confirma `auth login --claudeai` para assinatura. Status consultado com
  ambiente mínimo e diretórios privados: loggedIn false, authMethod none. Sem herança da API key,
  nenhum login nem pedido de modelo feito. Login dedicado requer ação humana no fluxo oficial.

## Atualização — exceção de autenticação e primeiro ensaio

O Operador autorizou explicitamente reutilizar a autenticação Claude existente pelo binário oficial,
sem extração/cópia de tokens, excluindo API key e configuração pessoal pelos mecanismos disponíveis.
Autorizou a limitação de isolamento e gravações nativas de sessão/refresh. Cleanup não deve fazer
logout, remover perfil pessoal ou alterar intencionalmente suas configurações. Selecionou **Haiku**
para reduzir consumo de quota. Nenhuma autorização de API paga foi acrescentada.

- Status nativo consultado com ambiente mínimo: loggedIn true, authMethod claude.ai, firstParty,
  assinatura Max. Somente esses metadados foram registrados; nenhuma credencial/email foi capturada.
- Binário oficial confirmou `2.1.325`. Handshake SDK sem prompt, sem pedido de modelo, resolve Haiku
  para `claude-haiku-5-5`. Inventário MCP vazio no audit sem ferramentas; fontes user/project/local
  desabilitadas e connectors desativados. Isso não elimina configuração global sempre lida pelo CLI.
- Typecheck e build completos passaram após preparo correto do staging. Root/runtime descartável
  Gondolin preparado pelo Sandbox público, usando assets existentes apenas para leitura, com pin
  `8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807`.
- Primeiro runner cobre um subconjunto J1, sequencialmente, com no máximo quatro ativações Haiku,
  até quatro turnos e 90 segundos por ativação; há limite de campanha de 60 minutos/20 ativações.
  Registra processos efetivos, ferramentas, modelo, pareceres e cessação. Usa Sandbox/Records reais;
  admissão e entrega de revisão são roteiro, não Controle real. Não alegar J1 integral ou C5 sem prova.
- Manifesto e hash do runner são gerados antes de `--execute`; runner possui recusa a repetição
  automática. Cada resultado parcial será classificado sem atribuir sucesso às jornadas ausentes.

## Gates pendentes

1. Executar primeiro subconjunto J1 e verificar inventário efetivo/cessação; parar em violação.
2. Preparar igualmente autenticação nativa OpenAI sem copiar tokens ou presumir API paga.
3. Completar os demais roteiros/manifests antes de suas inferências. J2/J3/D1/D2 ainda não foram executados.

Instalações e preparação acima não consumiram as 20 ativações nem iniciaram os 60 minutos de
execução real. Critérios C1–C12 continuam sem evidência de execução.

Não há resultado aprovado/reprovado dos critérios C1–C12; ainda não foram executados.
