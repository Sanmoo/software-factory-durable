# Aceite da v2 no perfil Lambda — plano de execução

Data: 2026-11-21. Ticket: [Aceite da v2 no perfil Lambda](../../software-factory-v2-lambda/issues/16-v2-acceptance-on-lambda-profile.md).
Requisitos em jogo: Seção 11 da [spec da v2](../spec.md) e os critérios CA-01 a CA-12 do
[PRD do MVP](../../software-factory/prd.md). Rubrica proposta: [rubrica v1](lambda-acceptance-rubric.json).

**Estado: autorizado pelo Operador em 2026-11-21**, como proposto na tabela "Autorização pedida", com a
[rubrica v1](lambda-acceptance-rubric.json) aprovada ([registro](lambda-acceptance-rubric-approval.json)).
A resposta do Operador foi "autorizo", dada à proposta que reunia a tabela e a rubrica. A autorização das
provas anteriores não vale aqui.

## O que já se sabe e o que muda o desenho

- A implementação da v2 está na `main` (`d0cb3634`), com `test:ci` verde. Tudo o que ela sabe do serviço
  real veio de três provas com protótipo; o adapter de produção nunca rodou fora de dublês. O primeiro
  boot real será a primeira execução do hook, do script de início, do `sshd` do guest, do clone e do
  lançador de worker.
- **Todo build de imagem falha hoje.** O molde do guest fixa `github-cli=2.83.0-r0`; o índice do Alpine
  v3.23 para ARM64 tem `2.83.0-r6`. Corrigir muda o hash do pin do guest e exige release nova.
- **O usuário root da conta não serve para operar.** A AWS não permite que root assuma roles, e a Factory
  exige um perfil que assuma `factory-<instalação>-operation`. Root só prepara a conta.
- **Não existe receita de conta real para o Lambda.** As receitas do MVP gravam o perfil Gondolin como
  constante. A campanha segue a forma dos pilotos: release instalada, CLI `factory`, leituras `gh` e
  `aws`, e injeção de falha por comandos externos.
- **O MVP não tem um aceite formal para repetir.** A matriz de qualificação tem 99 obrigações aprovadas
  e 13 dependentes de piloto; o ticket 35 segue aberto. "Reexecutar os critérios do MVP" aqui significa
  observar CA-01 a CA-12 no perfil Lambda, cada um com o seu limite declarado.
- **A quota limita a dois Trabalhos simultâneos** (8 GB de memória ARM alocada, 4 GB de pico por
  MicroVM). CA-03 com três Builders não cabe sem aumento de quota.
- Três repositórios auxiliares do MVP não existem mais (dependência oculta, spec privada).
- V2-04 (capacidade ausente) não tem como ser observado em conta real: o único requisito que um
  repositório consegue declarar hoje é Docker, e o Lambda declara Docker. Fica coberto só pelos testes
  compostos, e vai para "Não coberto".

## Autorização pedida

| Item | Proposta |
| --- | --- |
| Conta AWS | A do perfil `default` da AWS CLI local (confirmado pelo Operador em 2026-11-21). |
| Identidade | Root, só na preparação: aplicar o template da conta (`factory-sfv2acc-operation`, `factory-sfv2acc-build`, bucket de build) e criar o usuário IAM `factory-sfv2acc-operator`, cuja única permissão é assumir a role de operação (aceito pelo Operador em 2026-11-21). Uma chave de acesso desse usuário fica em `~/.aws/credentials`; um perfil `factory-sfv2acc` assume a role. A campanha roda só por esse perfil. Credenciais nunca são lidas, copiadas ou impressas. |
| Mudança de IAM durante a campanha | Uma: retirar uma ação da role de operação e recolocá-la, para observar V2-31. |
| Região e arquitetura | `us-east-1`, somente ARM64. |
| Tamanho | O padrão do perfil: baseline 1 GB / 0,5 vCPU, pico 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`. `concurrency: 2`. |
| Teto de custo AWS | US$ 30, com parada obrigatória ao estimar US$ 22. Base: as provas ficaram abaixo de US$ 0,47 por MicroVM-hora. |
| Tetos de uso AWS | 30 builds de imagem, 40 MicroVM-horas, 2 MicroVMs simultâneas, `maxBootSeconds` 3600 (um único boot de até 4500 s para o gate "acima de uma hora"). |
| Modelo | `openai/gpt-6-luna` nos três papéis, pelo login do Operador na raiz nova. Teto de 150 M tokens, com parada em 120 M. O piloto 2 registrou 137 M para três entregas de código. |
| Prazo | 7 dias corridos (até 2026-11-28); ao fim, cleanup mesmo com critérios incompletos. |
| Outros recursos AWS | A stack CloudFormation, o bucket de build e os log groups de build. Sem VPC, NAT ou ECR privado. |
| Repositório real | `Sanmoo/java-springboot-event-sourcing`: até 4 Tickets novos e seus PRs. Retirada temporária da regra `update` do ruleset para o merge humano, restaurada ao fim de cada janela, como nos pilotos. |
| Repositório de apoio | `Sanmoo/sfv2acc-fixture`, privado, criado e apagado pela campanha: casos negativos e destrutivos (declaração quebrada, histórico reescrito, branch apagada, check obrigatório, efeito incerto). Precisa estar na instalação do GitHub App. |
| Passos humanos no GitHub | Feitos por mim com a conta `gh` do Operador, cada um registrado antes de executar: criar Tickets e labels, responder Perguntas, aprovar e mesclar PRs, publicar o status `factory-gate`, empurrar commits de terceiro. O login do modelo e a cópia da chave do App são do Operador. |
| Host local | Raiz nova em `/home/sanmoo/software-factory-test/lb1`, controller em primeiro plano (sem unit de sistema). Evidência bruta em `/home/sanmoo/software-factory-test/v2-lambda-acceptance/`. Encerrar o controller órfão de 2026-11-17. Nenhum `test:ci` ou build no host durante uma janela. |
| Cleanup | MicroVMs, imagens, objetos e bucket, log groups, stack, usuário IAM e sua chave, perfil AWS, repositório de apoio, refs de marcador, branches e Tickets de teste fechados, ruleset restaurado. Cada remoção verificada por leitura. |

## Fases

Cada fase termina com evidência gravada ou recusa explícita. Defeito do produto encontrado numa fase vira
ticket; a correção segue o fluxo normal (TDD, `test:ci`, `main`), entra numa release nova e a fase é
repetida. Defeito que exija mudar a hipótese da v2 não é corrigido na campanha: é resultado e volta ao
Operador.

0. **Preparação sem custo.** Corrigir o pin do `github-cli`; fazer o `doctor` checar `ssh` e `websocat`;
   conferir os onze pins contra o índice do Alpine; verificar que `aws` resolve o perfil no ambiente do
   controller (sem `HOME`). Construir a release com os assets de guest já existentes. Checker da rubrica.
1. **Conta e validação (G30, X0).** Root aplica o template e cria o usuário; perfil novo; raiz instalada,
   `config.yaml`, chave do App e login do modelo (Operador). `doctor` saudável; `doctor` com
   `concurrency: 3`; `doctor` com uma ação retirada da role.
2. **Imagem (G27).** Primeiro build com o ambiente declarado do repositório real; build com versão
   inexistente no repositório de apoio; reuso da imagem por um segundo Trabalho.
3. **Boot, canal e ferramentas, antes de qualquer modelo caro (G23, G24).** Um Ticket trivial de
   documentação no repositório de apoio. Sondas pelo canal: revisor não escreve nem alcança Docker; nada
   de token em disco ou em `ps`; nenhuma credencial AWS no guest.
4. **Jornada (C01, C08, C10, C12, G32).** Ticket de documentação no repositório real até o merge e o
   cleanup; depois dois Tickets de código simultâneos com Testcontainers.
5. **Esperas e retomada (C02, C04, C05, C09, C11, G05, G09, G10, G11).** Pergunta com trabalho não
   salvo; espera de CI com o check `factory-gate`; commit de terceiro durante a espera; histórico
   reescrito; branch apagada; dependência nativa; conflito com a base.
6. **Troca planejada (G12, G14).** `maxBootSeconds` curto com tarefa longa; chamada longa em curso na
   metade da margem; um boot acima de uma hora; dois boots sem commit novo.
7. **Queda de canal, perda e substituta (G15, G16, G17, G20, C06, C07).** Túnel derrubado com a MicroVM
   viva; MicroVM encerrada por fora no meio de uma ativação; efeito incerto roteirizado; `SIGKILL` do
   controller no meio de um boot; cancelamento; limite esgotado.
8. **Finalização (X1, X2).** Pelo [helper de finalização](../../../scripts/agent-checks/finalize.mjs):
   cessação confirmada por `GetMicrovm`, evidência sanitizada gravada, avaliação por critério, e só então
   as remoções da linha "Cleanup", cada uma verificada.

As fases 5 a 7 usam o repositório de apoio, com Tickets de documentação e gates POSIX, para gastar pouco
modelo. O repositório real fica com as jornadas da fase 4.

## Regras de parada

- Estimativa AWS em US$ 22, 120 M tokens, qualquer teto atingido ou prazo vencido: pausar a Factory e ir
  à finalização.
- Nenhuma MicroVM viva entre janelas de trabalho: toda janela termina com `list-microvms` sem itens fora
  de `TERMINATED` e com o controller parado.
- Falta de capacidade, quota insuficiente ou recusa de permissão fora do previsto: registrar e voltar ao
  Operador, sem outra região, conta ou permissão mais ampla.
- V2-15 e V2-17 a V2-19 são obrigatórios. Reprovado ou inconclusivo em qualquer um: o aceite não é
  registrado; o resultado vai ao Operador com a evidência.
- Critério reprovado ou inconclusivo é registrado como tal. Nada é promovido a provado sem observação.

## Evidência e integração

- Para a `main`: este plano, a rubrica com a aprovação, o relatório, a avaliação por critério, a evidência
  sanitizada e a resposta do ticket 16 com a coluna "Não coberto". Sem tokens, chaves, IDs de conta ou
  conteúdo de `runHookPayload`.
- Correções do produto: tickets próprios, pela `main`, como qualquer desenvolvimento.
- Código descartável (sondas, watcher de consumo, roteiros): branch local
  `prototype/v2-lambda-acceptance`, nunca integrada nem publicada.
- A evidência bruta fica no diretório local da campanha e só é apagada depois de conferida a cópia
  sanitizada.

## Limites conhecidos antes de começar

- **CA-03** é observado com dois Builders, não três. Três depende de aumento de quota, fora desta
  campanha.
- **CA-02** cobre só a dependência nativa no mesmo repositório. Dados inacessíveis dependem de um segundo
  repositório fora da instalação; fica com a evidência do MVP, que não depende do adapter.
- **CA-05** não cobre o comentário de conta não autorizada (exige uma segunda conta GitHub). **CA-07** não
  cobre falha de cleanup, e **CA-12** não cobre revisão indisponível: não há como injetar em conta real
  sem alterar o produto.
- **V2-04** não é observável em conta real (ver acima).
- **V2-15** é verificado pelos registros da própria Factory (sessão, uso por boot) contra o
  `terminatedAt` do serviço. Não há log do lado do provedor do modelo.
- **Três recusas do gate (V2-07)** dependem de um agente real que não consiga limpar o workspace. O
  roteiro recria um arquivo não rastreado por um processo injetado pelo canal; se o agente contornar, o
  critério fica inconclusivo.
- O custo por tag na cobrança da AWS só aparece depois de 24 horas e exige permissão de Cost Explorer que
  a role de operação não tem: a estimativa usa MicroVM-segundos e builds.
- O mirror do Alpine guarda só a revisão corrente de cada pacote: qualquer pin do molde pode vencer entre
  a release e a execução. Se vencer, é achado para o desenho, não um desvio a contornar.
