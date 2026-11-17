# Prova Pi/Claude — rodada complementar e proposta de veredito

**Revisão posterior sem inferências:** consultar [aceite local revisado](harness-proof-acceptance-review.md).
A auditoria reclassifica C3 e C9 para aprovados no recorte local, por evidência existente e pela
permissão de suspensão por cessação/fixtures na spec. Proposta atual: nove aprovados e três
inconclusivos; ainda sem aceite integral. A matriz abaixo preserva a interpretação anterior.

Asset de [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md).
Base: [spec aprovada](../harness-proof-spec.md) e [campanha anterior, preservada](harness-proof-summary.md).

**Resultado proposto, aguardando aprovação do Operador. Ticket permanece claimed; mapa não atualizado.**

## Veredito

**INCONCLUSIVO para aceitar o conjunto completo C1–C12.** A rodada fecha cancelamento local durante
ferramenta real, ambos os perfis mistos e a cobertura dirigida de confinamento. Amplia filtragem e
suspensão, sem converter ausência de observabilidade em aprovação. Não há violação de segurança
observada nem critério reprovado nesta rodada; ausência de evidência suficiente continua inconclusiva.
Não homologar produção, Lambda ou integração com Controle real.

A campanha anterior continua encerrada em **20 ativações**. A nova rodada, autorizada separadamente,
encerrou em **10 ativações novas**, total histórico **30**, sem reutilizar saldo ou reiniciar contadores.
Débito dos runners: **257373 ms** (4min17s, incluindo reserva conservadora inicial de 60s). Débito
final conservador: **300000 ms** (5min), reservando mais 42627ms para validação/auditoria offline.
Planejamento e espera humana não contam como execução real. Nenhuma ampliação do teto foi necessária.
O valor não é saldo da assinatura nem tempo/custo efetivo de processamento do fornecedor.

## Perfil efetivamente revalidado

- MVP fixado em `aabe06abfb20e83593020c0fee19b078d235466b`: **124 arquivos de src** comparados pelos
  hashes Git com a cópia local. A cópia não tem HEAD utilizável; não se usou essa ausência como
  identificação de versão. Nenhuma implementação mais recente foi adotada ou alterada.
- Node **24.21.0**, Claude Code oficial **2.1.325**, Agent SDK **0.3.325**.
- Haiku alias `haiku` resolvido pelo handshake sem prompt para **claude-haiku-5-5**; ativações reais
  confirmaram esse identificador e exclusivamente as tools MCP esperadas. Esforço solicitado low.
- Status nativo Claude: loggedIn, **claude.ai / firstParty / max**. Binário inalterado, ambiente
  por allowlist sem API keys, connectors/skills/plugins/memória automática e built-ins desabilitados.
  Os seis init reais informaram `apiKeySource: none`. A auditoria final registrou somente presença
  de variáveis: havia chave Anthropic no host, **excluída da allowlist do filho Claude**; overrides
  OpenAI estavam ausentes. Nenhum valor foi lido/copiado para relatório. Essa checagem final não
  equivale a instrumentação pré-request retroativa.
  Uso pessoal pelo próprio Operador, conforme exceção já aprovada; não é oferta de login/assinatura a
  terceiros. Configuração global pessoal que o CLI sempre lê continua limitação, sem copiar tokens.
- Pi **1.5.2**, perfil **factory-development-pi-1.5.2-read-async-bash-lexical-v3**;
  modelo **openai/gpt-6-luna**, API nativa openai-responses e credencial de tipo OAuth confirmados
  pela metadata do ModelRuntime antes de cada prompt. Sem leitura manual de credenciais.
- Gondolin **0.14.0**, perfil **factory-development-gondolin-0.14.0-stdin-capacity-v1**;
  verificação staged de ambos os SDKs passou. Manifestos/hashes estão na evidência, não só nomes.
- Mesmo pin de assets `8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807`,
  1 vCPU, 1024 MiB e disco virtual 4 GiB. Root próprio curto `/home/sanmoo/sfhp-v2/d`.
- Fontes oficiais reconsultadas: [legal/compliance](https://code.claude.com/docs/en/legal-and-compliance.md),
  [autenticação](https://code.claude.com/docs/en/authentication.md) e
  [Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).
  Documentação distingue uso individual dos binários nativos de intermediação/oferta de login por
  produto terceiro. Esta prova não resolve enquadramento de uma futura distribuição da fábrica.

## Preparação sem modelos e falhas preservadas

Antes da primeira inferência passaram **12 testes determinísticos**: os oito testes anteriores de
captura/paginação e classificação de erro/modelo, mais quatro oráculos novos. O oráculo de cessação
recusa a conclusão ao retirar qualquer observação obrigatória; PASS sem tools/leituras não é revisão;
tokens sem ferramenta não provam consumo; falha de filtro não libera texto parcial.

O boot de preflight também testou projeções reais, read/page, Git e inventários Pi sem prompt.
Handshake Claude não enviou prompt. Dois problemas de preparação foram registrados e corrigidos:

1. O runner tentou abrir Records sem criar o diretório privado. Falhou antes de ambiente/modelo;
   reservados conservadoramente 60s. O timestamp de fim desse primeiro registro foi preenchido para
   contabilidade, não é observação física de cessação.
2. O oráculo comparava `claude-haiku-5-5` com `value` da lista de modelos, que contém `haiku`.
   A comparação passou a aceitar `resolvedModel`. Não é mudança de modelo nem incompatibilidade.

A auditoria posterior detectou ainda uma falha do próprio scanner: barra final no cwd produzia um
nome de projeto Claude incorreto. O scan inicial, de quatro arquivos Pi, **não prova** ausência de
canário em Claude. A décima ativação foi reservada especificamente para obter e auditar essa
observação no diretório correto antes de apagar a sessão. Nenhum resultado anterior foi reescrito.

## Cancelamento real — nova evidência para C7

A primeira ativação Claude executou uma ferramenta bash real no guest: processo foreground com
`sleep`, filho background atualizando `pulse.txt` e escrita tardia em `late.txt`. Cancelamento somente
após receber o marcador real `TOOL_RUNNING`, não apenas após um timer de lançamento.

Linha do tempo UTC de 2026-11-16:

- **09:31:50.116:** primeira ativação admitida.
- **09:31:52.525:** progresso guest observado; abort/close nativos acionados.
- **09:31:56.540:** Sandbox observou stopped / cessationConfirmed; stop também informou
  `termination: unconfirmed` e `guestFinalization: observed`. Não se interpreta isso como término
  gracioso confirmado; a propriedade usada é a confirmação independente de cessação.
- **09:31:57.242:** grupo de processos próprio Claude vazio, ferramenta settled; marcador de
  heartbeat não mudou na janela posterior e a escrita tardia não existia.
- **09:31:57.799:** runner liberou admissão de substituto após cleanup do ambiente anterior.
- **09:32:24.084:** ativação seguinte admitida em outro ambiente, sem escritor anterior ativo.

O MCP é servidor SDK in-process, não um daemon persistente separado. O CLI foi lançado em grupo
próprio; inventário `/proc` do grupo e cessação do Sandbox cobrem processos locais/guest deste perfil.
A prova usa **parada do guest inteiro** como reconciliação de cessação: não afirma que abort de
Promise, interrupt ACK ou retorno da ferramenta isoladamente mate todos os descendentes. Não prova
que o fornecedor remoto deixou de processar/cobrar um request já enviado; consumo desse request
interrompido permanece desconhecido, não zero. Serviço de admissão continua fixture.

## Perfis mistos — nova evidência para C10

O mesmo checkout sintético em `/workspace/checkout` foi usado por ambos os arranjos. A tarefa já
estava correta: Builders apenas leram/executaram o teste aritmético, sem repetir o caso de correção
já demonstrado. Objetivo desta rodada era revisão/retorno entre harnesses, não nova implementação.

| Ativações novas | Arranjo e observação |
| --- | --- |
| 2–5 | Claude Builder → Pi Standards → Pi Spec → nova admissão Claude Builder. |
| 6–9 | Pi Builder → Claude Standards → Claude Spec → nova admissão Pi Builder. |

Os dois revisores Pi tinham **factory_read efetivamente ativa antes da inferência**; leram tanto o
código quanto padrões/pedido. Cada um fez três chamadas read, incluindo uma releitura, e três
requests Pi observados. Produziram respectivamente `PASS — CLAUDE-STD` e `PASS CLAUDE-SPEC`.
O Builder Claude recebeu os pareceres completos, releu o arquivo e confirmou ambos sem pedir mudança.
Os revisores Claude leram seus dois arquivos, retornaram `PASS PI-STD` / `PASS PI-SPEC`; o Builder Pi
recebeu os pareceres, releu o arquivo e confirmou ambos. OIDs remotos e gates locais permaneceram
coerentes; não houve alteração de conteúdo, WIP ou publicação nova a demonstrar nesta rodada.

Os Builders anteriores haviam cessado antes de admitir revisores. Para Pi há gate pré-request e
session dispose; para Claude há grupo local vazio, mas falta hook de início de request na API
observada. As sessões de retorno são novas admissões nativas com relatórios explícitos, sem
transcripts anteriores. A recusa nativa Pi histórica permanece no histórico; não houve nova recusa,
retry automático ou prompt reescrito para evasão. A mudança técnica relevante foi habilitar tools.

## Confinamento e filtragem

Ensaios dirigidos na API pública real, sem pedir ao modelo que inventasse um ataque:

- Escrita e bash de revisor recusados: **WRITE_ROLE_DENIED / BASH_ROLE_DENIED**.
- Traversal e caminho host recusados: **READ_PATH_DENIED**.
- Symlink de checkout para `/etc/passwd` guest recusado: **GUEST_READ_FAILED**.
- Symlink interno para arquivo autorizado leu corretamente. Sentinela permaneceu SAFE, sem arquivo
  criado por revisor. Confirmação de filesystem independente da mensagem de recusa.
- Tentativa de read/capture raw fora do formato da projeção recusada: **INVALID_TOOL_CALL**.
  Isso é recusa de schema, não homologação de um pipeline multimodal. Nenhum canal imagem habilitado.
- Inventários reais: Claude somente MCP factory por papel; Pi somente factory_read/factory_bash.
  Não se ofereceu ferramenta host, builtin ou MCP extra.

Canário sintético dividido em chunks passou por Records reais antes da liberação pelo bridge.
Falha dirigida UTF-8 inválido bloqueou entrega completa (`OUTPUT_BLOCKED`), sem retornar prefixo
parcial. Payloads de erro/progresso shaped foram exercitados deterministicamente; não confundir
isso com todos os canais nativos de erro/progresso de ambos os harnesses.

Na ativação 10, Claude leu a saída guest real com canário em stdout, stderr e trecho atrasado. O
bridge verificou ausência bruta antes da entrega; o modelo observou redação e marcador final.
O scan corrigido encontrou **um arquivo Claude nativo real**, sem canário bruto, antes de deleteSession.
O valor bruto não é mantido no relatório, só seu hash. O scanner não auditou logs pessoais/globais
compartilhados nem internals do fornecedor. O erro de filtragem foi provado em Records/bridge,
mas não por uma falha nativa MCP entregue ao modelo. **C5 integral permanece inconclusivo.**

## Matriz acumulada C1–C12

Aprovado sempre significa somente o perfil/fronteira local descrito, não fábrica integrada.

| Critério | Proposta | Evidência ou lacuna que impede aprovação |
| --- | --- | --- |
| C1 — tarefa e três papéis Claude | **Aprovado** | Mantida evidência anterior; não repetida correção da tarefa. |
| C2 — pareceres e consumo | **Aprovado** | Anterior + relatórios completos entregues/consumidos nos dois arranjos mistos. Controle é fixture. |
| C3 — suspensão sem novos requests | **Inconclusivo** | Pi tem gate pré-request/idle/dispose; Claude tem cessação física antes dos revisores, não oráculo completo de início de request/background na fronteira nativa. Limite da spec mantido. |
| C4 — confinamento/read-only | **Aprovado** | Cobertura dirigida de escrita/bash, traversal, symlink externo/interno, host path, sentinela intacta e inventários reais mínimos; recorte da projeção fixada. |
| C5 — filtragem antes do harness/persistência | **Inconclusivo** | Split canary, falha Records/bridge e scan Claude corrigido reais; não se completou observação nativa de todos os erros/progressos/auxiliares do perfil pessoal. |
| C6 — pergunta/ACK/gate/retomada | **Inconclusivo** | Caminho positivo anterior preservado; sem repetir caso. ACK/Controle ainda fixture e fronteira pré-request Claude incompleta. |
| C7 — cancelamento em tool/cessação | **Aprovado** | Progresso real antes do cancelamento, grupo host vazio, ferramenta settled, guest cessado, heartbeat estável e sem escrita tardia antes de novo escritor. Incerteza de consumo remoto explicitada. |
| C8 — duas direções/sessões novas | **Aprovado** | Pi→Claude→Pi com clones/origin na campanha anterior; não repetido sem motivo. |
| C9 — histórico/consumo/controles | **Inconclusivo** | Contexto sem transcript e contadores preservados no runner; Controle/contabilidade duráveis de produção não exercitados. |
| C10 — ambos os perfis mistos | **Aprovado** | Ambos os arranjos concluídos com tools ativas, leituras, relatórios distintos e retorno ao Builder. |
| C11 — perda antes do push | **Aprovado** | Evidência anterior preservada; não repetida. |
| C12 — efeito externo incerto | **Inconclusivo** | Impedimento anterior continua fixture sem contador independente de tentativas de efeito; não exercitado nesta rodada. |

**Sete aprovados, cinco inconclusivos, zero reprovados. Qualquer obrigatório inconclusivo impede
aprovar o conjunto.** Resultados negativos do ensaio anterior, incluindo quota, bridge, tools ausentes,
recusa Pi e readiness, continuam preservados; correção posterior não os apaga nem os redefine como
incompatibilidade de harness. O resultado desta prova pode alimentar a decisão de composição, sem
propor aqui novos tickets, adapters ou interfaces de produção.

## Contabilidade e evidência

[Registro sanitizado da rodada](harness-proof-complement.json) mantém manifestos por execução,
linhas do tempo, pareceres completos, sessões, OIDs, consumo SDK e falhas do ensaio. Commits que
produziram observações: **ac58753** para --execute e **60686bb** para --filter; cada manifesto fixa o
hash do runner. Mudanças posteriores de auditoria não reescrevem essa proveniência.

Foram seis ativações Claude (uma interrompida, cinco concluídas) e quatro Pi. Pi registrou dez
requests de modelo, com usage por mensagem. Claude expõe usage dos resultados concluídos, mas
não fornece nesta prova contagem pré-request completa ou consumo final da ativação cancelada.
Estimativas USD dos SDKs não são fatura nem saldo da assinatura; ausência de resultado não é zero.
Nenhum fallback, API paga, AWS/Lambda, GitHub real ou push externo foi executado.

## Validação dos registros

- 12 testes determinísticos passaram novamente após o ensaio; `node --check` passou para runner e
  auditoria. `git diff --check` sem problemas.
- Validador offline confirmou hashes de fonte contra os commits produtores, budgets encerrados,
  todas as observações do cancelamento, os dois perfis mistos, scan Claude real, contagens de cleanup
  e ausência de diff no mapa.
- LSP consultado em quatro arquivos novos: zero diagnósticos reportados, mas só um confirmado clean
  e três inconclusivos por servidor push-only/silent-on-clean. Não é declaração de typecheck completo.

## Cleanup, reprodução e integração

[Auditoria independente de cleanup e perfis](harness-proof-complement-cleanup.json), sem inferências:

- **Cinco ambientes** reobservados removed / cessationConfirmed: disco, workspace, artifacts e
  runtime removidos pela API pública. Nenhum alias hardlink de Git: os repositórios locais novos
  desta rodada não usam clone; a regra --no-hardlinks permanece para futuras reconstruções.
- **Oito grupos de processos Claude** próprios vazios (seis ativações + dois handshakes sem modelo).
- **Seis sessões Claude** ausentes, confirmadas pelo getSessionInfo oficial após deleteSession.
- **Oito diretórios Pi** próprios ausentes; cwd/projeto Claude exclusivos vazios foram removidos
  com rmdir, sem remoção recursiva de diretórios compartilhados.
- Capturas Records sintéticas desta rodada removidas após preservar evidência sanitizada.
  Metadados de lifecycle/auditoria, snapshot e dependências locais permanecem para reprodução.
- Sem logout, cópia de tokens, alteração intencional de credenciais/configuração pessoal ou cleanup
  de sessões/processos de outras frentes.

Runners descartáveis disponíveis somente na branch **prototype/v2-harness-proof**, sob
`.scratch/software-factory-v2/prototype/`: `complement-proof.mjs`, `complement-oracles.mjs`,
`complement-oracles.test.mjs` e `complement-audit.mjs`. Esse contexto aponta para a branch local,
não pressupõe arquivos de protótipo em main nem uma branch publicada. Comandos usados na worktree da prova:

```sh
node --test .scratch/software-factory-v2/prototype/*.test.mjs
node .scratch/software-factory-v2/prototype/complement-proof.mjs --check
node .scratch/software-factory-v2/prototype/complement-proof.mjs --execute
node .scratch/software-factory-v2/prototype/complement-proof.mjs --filter
node .scratch/software-factory-v2/prototype/complement-audit.mjs
```

A campanha está encerrada; comandos não autorizam repetição. O estado local impede repetir as
etapas de inferência e o teto de dez ativações foi atingido. Reprodução futura exige orçamento e
recursos novos explicitamente registrados, nunca apagar o ledger para contornar o gate.

Branch **prototype/v2-harness-proof**, worktree **.worktrees/harness-proof-run/** preservadas.
Destino documental original permanece **main no checkout principal**. **Sem integração nesta etapa**:
o resultado aguarda aprovação do Operador e a branch contém código descartável que não pode ir a
main. Não fazer merge integral. A integração posterior deve transportar somente registros/evidências
aprovados pelo workflow documental; o protótipo permanece como fonte na branch descartável, sem push.
