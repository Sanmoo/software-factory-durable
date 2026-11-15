# Seam de execução: harness versus sandbox — pesquisa do ticket v2 05

## 1. Resultado e limites

- Consulta documental: **2026-11-15**; reutiliza a pesquisa de assinatura de 2026-11-14, sem repetir seu inventário inteiro.
- **Resultado:** Workers já é o seam público candidato; Sandbox é outra fronteira, de ferramentas e ciclo do ambiente. Não há razão demonstrada para acrescentar uma camada pass-through.
- **HIPÓTESE preferida para a prova:** Claude oficial no host, sem built-ins, com ferramentas MCP/customizadas encaminhadas à projeção Sandbox e ao controlador. Há mecanismos oficiais promissores; compatibilidade ainda não foi demonstrada.
- Não se escolhem adoção, interface TypeScript definitiva, versão de Claude para produção ou mecanismo final de suspensão.
- Direções aprovadas: [04](../issues/04-substitutable-harnesses-direction.md#answer) e [01](../issues/01-lambda-microvms-direction.md#answer). MVP permanece autoridade do MVP, não especificação automaticamente alterada pela v2.
- Esta pesquisa não executou modelo, login, credenciais, instalação, testes, protótipo ou infraestrutura. Relatos de ensaios abaixo são evidências existentes, não execuções desta sessão.

## 2. Fontes, versões e rastreabilidade

- **[M] Snapshot imutável:** `aabe06abfb20e83593020c0fee19b078d235466b`, integração MVP; HEAD conferido em `.worktrees/v2-execution-seam-source/`, usado somente para leitura.
- Referências `[M] caminho:Lx–Ly` neste relatório são linhas desse SHA; podem ser auditadas com `git show aabe06ab:CAMINHO | nl -ba`. Não são referências a branches em andamento.
- Autoridade de desenho: `[M] .scratch/software-factory/module-public-interfaces.md`, Q5–Q9/Q13; e `spec.md`, §§2.3–2.4, 5, 6, 7, 11.4. Aprovação arquitetural está registrada no ticket original 26, não constitui ensaio.
- `[M] package.json:1–69`: Node **24.21.0**, npm **11.19.0**, Pi coding-agent **1.5.2**, Pi Durable **1.5.0**, Gondolin **0.14.0**; dependências fixadas não provam o funcionamento da combinação v2.
- Pi efetivo não é upstream puro: `[M] src/workers/sdk-profile.ts:9–36,53–110` verifica upstream/patches e prepara staging v3; `package.json` resolve `#factory-pi` para `.scratch/factory-development-sdk-v3/sdk/dist/index.js`.
- Perfil inclui correções de read/path, Bash assíncrono e fila lexical; manifesto de perfil é gerado/verificado pelo preparo. Não extrapolar essa liberdade de patch ao binário Claude que deve permanecer inalterado.
- Migração histórica consultada em `docs/migrations/software-factory-from-pkm.md`: SHAs/caminhos de PKM anteriores não designam este snapshot.
- Fontes oficiais atuais foram extraídas pelo acesso web do supervisor; cópias de consulta somente leitura, com URL de origem. Tentativas diretas via urllib receberam HTTP 403; não foram tomadas como conteúdo das páginas.
- **[C1]** [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md), seções de oferta em produtos, uso aceitável e autenticação.
- **[C2]** [Headless/programmatic](https://code.claude.com/docs/en/headless.md), saída estruturada, bare, sessões, background e SIGTERM.
- **[C3]** [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), definição do harness e aviso para terceiros.
- **[C4]** [TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript), `Options`, `Query`, resultados, interrupção e configuração; fonte extensa consultada seletivamente.
- **[C5]** [Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), ordem de avaliação, allow/deny, modos e callback.
- **[C6]** [Custom tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools), MCP in-process e separação disponibilidade/permissão.
- **[C7]** [Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions), continue/resume/fork e persistência nativa.
- **[C8]** [Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks), `PreToolUse`, `PostToolUse`, `permissionDecision` e saídas substitutas.
- **[C9]** [Authentication](https://code.claude.com/docs/en/authentication.md), perfis, `CLAUDE_CONFIG_DIR` e precedência de credenciais; [features/configuração SDK](https://platform.claude.com/docs/en/agent-sdk/claude-code-features).
- **[C10]** [Uso do SDK com plano Claude](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), atualizações de 15/06 e 07/10/2026.
- Páginas são mutáveis, não release notes de versão instalada. A prova deverá fixar binário/SDK/Node e opções efetivas; `permission_policy` TypeScript, por exemplo, requer SDK **v0.3.301+** em [C6]. Nenhuma versão Claude foi instalada ou homologada.

## 3. Inventário: contrato aprovado versus código

| Fronteira | Aprovado | Implementado no snapshot [M] e custo para v2 |
| --- | --- | --- |
| Workers | `activate/deliver/observe/interrupt`; recibo antes de modelo/ferramenta; entrega não significa consumo; interrupt não significa cessação | `src/workers/index.ts:82–112,127–203,233–270` compõe start/opinion/session, perfis e launch; há seam real, mas tipos e validações internos continuam Pi |
| Loop/sessão | Builder parado no handoff, sem turnos/ferramentas; perguntas encerram ativação; revisão pertence ao controlador | `src/workers/worker-session.ts:55–225`: resources explícitos, tools/customTools, gates, bloqueio de stream; não é apenas prompt |
| Protocol | Socket Unix privado, identidade vinculada pelo host, frames completos; não concede autorização nem ACK durável | `src/protocol/index.ts:6–25,36–121,123–170`: versão 1, limite 64 KiB, Channel/listen/connect; tradução de eventos Claude deve permanecer dentro de Workers |
| Sandbox | `validate/prepare/start/executeTool/observe/stop/remove`; projeções por papel/boot; dono único do ambiente | `src/sandbox/index.ts:25–72`, `read-tools.ts:30,170–180,349–360,401–410` e `tool-binding.ts:5–7,36–51`: `ToolProjection.executeTool`, vínculo e checagem de contexto; não recebe autoridade de filas ou sessões |
| Ferramentas | Builder escreve/executa no guest; Standards/Spec somente `read` confinado | `src/workers/worker-session.ts:145–170`; `sandbox/read-tools.ts:241–280`, `bash-tools.ts:71–100`: backend e captura filtrada antes de retorno |
| Sessão/perfil | Continuar somente compatível; substituir com motivo/contexto; não converter transcripts | `src/workers/session-ref.ts:1–24`: formato literal `pi-session-jsonl-v3`, SDK/provider/model/skill/tools; ainda não é identidade multiharness |
| Host/bootstrap | Perfil próprio, processo supervisionado, identidade e segredos fora do guest | `src/platform/host/worker-session-file.ts:17–25,110–111` repete schema Pi; `worker-bootstrap.ts:3–49` transporta continuação e perfil |
| Composição | Entrypoints injetam projeções públicas; Pi Durable privado ao Controle, Pi coding privado a Workers, Gondolin privado a Sandbox | `src/entrypoints/controller/composition.ts:40–110` valida papel/modelo do release e cria Workers único; adicionar Claude não é trocar provider |

### Vazamentos concretos e garantias que não podem desaparecer

- `[M] src/workers/worker-start.ts:16–45`: `ReviewerProfile.id` literal do SDK; ramo OAuth aceita OpenAI/`gpt-6-luna`/`openai-responses`. Não existe hoje configuração de assinatura Claude equivalente.
- `[M] src/workers/worker-start.ts:61–75`: recibo inclui perfil, modo e formato Pi; generalização futura envolve evidência/compatibilidade, não somente executor.
- `[M] src/workers/worker-session.ts:71–81,108–135`: `ResourceLoader`, `SessionManager`, skills e templates são APIs Pi; recursos Factory apontam para `/artifacts`, não home pessoal.
- `[M] src/workers/worker-process.ts:91–123`: bootstrap valida ambiente estreito e recusa input com segredo em vez de reescrevê-lo. Claude precisa descobrir autenticação nativa sem reabrir herança pessoal indiscriminada.
- `[M] src/workers/worker-session.ts:99–106,177–225`: após `ask_user`, bloqueia ferramentas e nova inferência; no handoff todas as tools são suspendable e `runtime.streamSimple` recusa qualquer pedido enquanto suspenso.
- Portanto tool MCP aguardando uma Promise **não prova** suspensão equivalente: batches, inferência subsequente, background e crash precisam de oráculo próprio.
- `[M] src/control/rules/continuation.ts:46–56` já decide substituir sessão ausente/alterada/incompatível; isso é útil, mas não oferece reconstrução de ambiente.
- `[M] src/control/rules/continuation.ts:59–73`, `recoveryContext`: exige mesmo base/branch/checkout e `prepared.reused === true`; clone novo gera `PREVIOUS_ENVIRONMENT_NOT_REUSED`, mesmo no mesmo commit.
- Esse pressuposto preservacionista é coerente com MVP; v2 Git-remoto/reconstrução exige revisão explícita de contrato/contexto. Não é bug a corrigir nesta pesquisa.
- `[M] src/entrypoints/controller/composition.ts:48–60`: modelos/papéis divergentes do perfil de release são recusados. Modelos independentes por papel da direção04 exigem composição/perfil v2, sem fallback implícito.
- `[M] src/entrypoints/release.ts:59–90`: o prompt de implementação proíbe push; publicação é um modo próprio, posterior à verificação. A direção01 v2 exige WIP commit/push antes de pergunta humana. Essa diferença exige revisão explícita de modos, autorização/credenciais e gate na v2; não basta adicionar um hook ao ask_user nem reusar o fluxo MVP sem adaptação. Não autoriza publicar WIP sob o perfil atual.
- Filtragem é anterior à persistência nativa (§2.3 da spec): `Records.openOutput` não é mero filtro de logs depois do modelo. O adapter Claude não pode receber bruto e só saneá-lo na saída externa.
- `[M] src/workers/read.ts:45–68`, `bash.ts:17–34` recebem resultados/capturas filtrados; `src/sandbox/read-tools.ts:241–280` e `bash-tools.ts:87–100` abrem captura antes de entregar conteúdo.
- Trocar Pi por Claude envolve wrappers de tools, loader, sessão, perfis, recibos, schemas host e regras de compatibilidade; ainda assim não demanda outro controlador durável ou framework universal.

## 4. Matriz Pi / CLI / Agent SDK

| Aspecto | Pi efetivo no MVP [M] | Claude CLI oficial [C2] | Agent SDK oficial [C3–C8] |
| --- | --- | --- | --- |
| Ativação | Worker host com recibo persistido e modelo explícito | `claude -p`, JSON/stream-json; processo não é recibo Factory | `query`, mensagens tipadas; SDK executa harness/binário Claude, não é cliente HTTP genérico |
| Eventos/fim | Workers normaliza pergunta/handoff/parecer/fim/uso | Stream precisa validação e correlação, não scraping de texto | Eventos/result subtype/session ID ajudam; ainda precisam mapear fronteiras duráveis |
| Tools guest | Lista explícita + implementações próprias via Sandbox | MCP externo/configurado e opções CLI; requer controle do perfil efetivo | `tools: []` + MCP in-process/custom tools é candidato direto; built-ins podem ser retirados |
| Pergunta | Tool preserva/envia, ACK durável, aborta ativação | Pergunta nativa não é pergunta persistida da Factory | Custom tool/hook pode encaminhar; ACK, encerramento e retomada continuam obrigação do adapter |
| Revisão | Builder suspenso; dois revisores controlados, só read | Não substituir pelos subagentes CLI | Configurar três papéis/fluxos Factory, não delegação nativa autônoma |
| Sessão | Pi JSONL v3 e comparação estrita de perfil | ID/resume nativo, sem equivalência ao Pi | continue/resume/fork; preferir ID explícito, nunca “última sessão” em concorrência |
| Cessação | Sandbox/host/cgroups observam conjunto, não só abort | Exit code, SIGTERM e fim de stream não provam todos os efeitos cessados | `interrupt()` tem recibo/caveats; MCP/descendentes precisam cessação separada |
| Uso/modelos | Recibos e consumo Factory separados de tokens | Métricas da saída não são saldo/quota da assinatura | Usage/custo/modelUsage quando presentes; ausência ≠ zero e custo estimado ≠ fatura/plano |
| Erros/quota | Falha mantém contexto/limites e impedimento | Login expirado/quota/rede não autorizam API fallback | Result de erro/limite e exceção de transporte são classes distintas; nenhum autoriza outro harness |

- Não comparar sessões pelo nome do modelo apenas: instruções, ferramentas, skills, versão do harness, auth/config efetivas e ambiente restaurado mudam compatibilidade.
- [C7] resume restaura contexto anterior, incluindo suposições sobre arquivos. Reaproveitar sessão após perda sem confirmar Git/estado é perigoso; sessão substituta é caminho legítimo da direção04.
- [C2] execução headless pode carregar configuração de home/projeto sem diálogo interativo de confiança; o adapter precisa de perfil independente e inventário efetivo de recursos.

## 5. Loop no host, ferramentas no guest: mecanismos oficiais e limites

1. **MCP/custom tools:** [C6] permite funções no processo do SDK (`createSdkMcpServer`) e tools com nome qualificado `mcp__...`. A função pode validar contexto/papel e usar transporte ao guest; não requer Bash/Edit host.
2. **Disponibilidade:** [C6, “Control tool access”] afirma que `tools: []` remove todos os built-ins; lista explícita mantém somente os listados. MCP é independente e precisa ser controlado separadamente.
3. **Deny:** [C4–C6] nome simples em `disallowedTools` remove built-in; regra escopada como `Bash(rm *)` deixa a ferramenta e nega matches como escritos. Não é analisador universal de shell nem isolamento de SO.
4. **Allow:** `allowedTools` autoaprova chamadas; omissão não equivale a proibição. Não serve como prova de ausência de ferramentas, de somente leitura ou de confinamento.
5. **Bypass:** deny rules continuam relevantes na avaliação documentada, mas `bypassPermissions` aprova o que chega a esse estágio; não habilitar como substituto de política. Também não recoloca built-ins que foram removidos por disponibilidade.
6. **Callback:** `canUseTool` só é consultado quando as etapas anteriores não resolvem; tools autoaprovadas podem nunca passar por ele. `PreToolUse` alcança casos aprovados e pode negar/modificar input; falha de hook precisa ser examinada, não presumida fail-closed.
7. **Hooks não são executor remoto genérico:** modificar input de Bash para incluir SSH ainda deixa Bash host disponível; bloquear built-in e executar via hook pode criar efeito sem semântica correta de tool result. MCP explícito evita essa ambiguidade inicial.
8. **Suspensão:** [C8] documenta `permissionDecision: defer`, que termina o turno com `tool_deferred`; é candidato a provar handoff/pergunta com ACK durável e retomada sem repetir tool/pergunta, não prova de barreira pré-request equivalente ao wrapper Pi nem de cessação de background.
9. **Resultados:** [C8] `updatedToolOutput` pode substituir output de built-ins e MCP antes de Claude; `updatedMCPToolOutput` antigo cobre MCP. O texto não garante ordem anterior à gravação de transcript nativo.
10. **Filtragem preferível na hipótese:** custom tool só recebe/devolve conteúdo já filtrado por Records/Sandbox, inclusive progress/chunks/erros. Evitar que bruto entre no harness é mais forte que tentar corrigir transcript depois.
11. Ainda provar inputs, prompts, imagens, mensagens de erro, hooks auxiliares, logs MCP e callbacks: filtrar apenas resultado textual feliz não cobre todos os canais persistidos.
12. Confinamento real reside no backend/guest e na autoridade host confiável. Remoção documentada de built-ins limita superfície do modelo, não torna todo o processo Claude/MCP uma sandbox contra comprometimento.

### Perfil, settings e autenticação não são o mesmo problema

- [C4, `Options`] usa **`settingSources`**, singular: default herda fontes CLI; `[]` desativa user/project/local, mas managed policy permanece. Não confundir com o nome informal `settingsSources`.
- [C4] `strictMcpConfig` limita MCP ao configurado, inclusive evitando descoberta por plugins/connectors; ausência de configuração explícita não é prova de inventário vazio.
- [C9] `CLAUDE_CONFIG_DIR` separa settings/history/login; não é confinamento de arquivos/rede. Dedicated home/cwd/env e fontes de instruções precisam ser declarados, não descobertos do operador.
- [C4] `env` substitui o ambiente do subprocesso, não simplesmente merge: projetar ambiente mínimo e autenticação nativa requer prova, sem copiar tokens para o adapter/Pi.
- Skills/templates Pi sob `/artifacts` não são automaticamente skills Claude. H1 precisa de cwd host privado **real** (Pi usa `/workspace` lógico), sem descobrir repo/skills no host; transportar instruções como dados versionados e resolver arquivos guest via MCP read, sem workspace host obrigatório.
- Managed policy, plugins, hooks e arquivos de instruções podem alterar comportamento apesar do perfil dedicado. Inventário efetivo e incompatibilidade diagnosticada são requisito, não opção de fallback.
- [C2] `--bare` não lê OAuth/keychain e não suporta login por assinatura; não é solução para assinatura + perfil limpo.
- [C9] credenciais de ambiente/provider/profile podem prevalecer sobre OAuth da assinatura; `ANTHROPIC_API_KEY` em headless pode gerar cobrança API. Validar origem efetiva sem imprimir segredos e bloquear fallback não aprovado.

## 6. Permissão comercial versus viabilidade técnica

- Pesquisa anterior: [claude-code-subscription.md](../../software-factory/research/claude-code-subscription.md), reaproveitada como contexto, não autorização.
- Revalidação decisiva [C10]: SDK e `claude -p`, autenticados pelo plano, continuam consumindo limites da assinatura (atualização 07/10/2026); isso prova regra documentada de consumo, não enquadramento comercial da Factory.
- [C1] limites pressupõem uso ordinário individual de Claude Code/Agent SDK; OAuth de planos destina-se a aplicativos nativos. Produtos/serviços terceiros devem usar API key/provider, sem intermediar credenciais Claude.ai ou oferecer login próprio.
- [C1] ressalva usuário final autenticando sua assinatura no **binário inalterado**, inclusive hospedado; oferta em produto está sujeita a Commercial Terms/condições de autenticação, sem pagar/revender/intermediar uso do usuário.
- [C3] mantém aviso de aprovação prévia para terceiros oferecerem login/limites Claude.ai em produtos SDK. Não apagar esse aviso porque MCP e `query` são tecnicamente suportados.
- Uso próprio do Operador é a direção aprovada; ainda é necessário confirmar enquadramento do arranjo concreto antes da prova/adoção por assinatura. Não declarar proibição absoluta de automação nem permissão geral de backend.
- API key/provider é alternativa comercial documentada, mas cobrança diferente exige autorização explícita; créditos API não equivalem a quota da assinatura e não autorizam fallback.

## 7. O que o MVP demonstrou — e o que não transfere

- **Aprovado:** desenho do ticket original 26/interfaces/spec; **implementado:** símbolos do SHA [M]; **demonstrado:** resultados abaixo, delimitados pelos seus próprios ensaios. Nenhuma dessas categorias comprova Claude ou Lambda.
- **E18:** `[M] docs/evidence/18-first-integrated-delivery-journey.md:1–42`, `q18-journey-v4` aprovado: pergunta/resposta, revisão, publicação, gate GitHub, merge humano e cleanup na composição de produção. V1–V3 encontraram gaps; não são descartados como se nunca tivessem ocorrido.
- E18 registra política de comando guest em commit separado/não integrado, a incorporar na trilha21; análise textual é defesa em profundidade, não contenção universal. Também registra filtro de inventário da receita compartilhada. Não concluir que “MVP integrado” elimina todas as pendências de autoridade/publicação.
- **E26:** `[M] docs/evidence/26-execution-recovery-without-survivor-adoption.md:8–10,14–58,70–78`, `q26-recovery-v2`: sobreviventes cessados, recibo descoberto, consumo único, cortes reais e parada limpa; v1 teve defeito de oráculo.
- E26: efeitos ambíguos não são reexecutados; duração pode ser lower-bound. `retry-after` tem regra, mas a tabela registra que nenhum adapter atual o entrega ao Controle. Claude precisa produzir observações de quota sem inventar disponibilidade.
- **E28:** `[M] docs/evidence/28-partial-review-recovery.md:9–40`, `q28-partial-v2`, inspeção corrigida **7/7**: preservar parecer válido/repor revisor faltante, entrega ≠ consumo. Corte no handoff provado em I-local com processos, sem VM/modelo; não atribuir a esse corte uma prova Claude real.
- **E33:** `[M] docs/evidence/33-compatible-upgrades-and-recoverable-migration.md:1–24,192–218`: `r33-v2` aprovado **54/54**, após v1 inconclusiva; upgrade sob lock, compatibilidade, pausa, migração explícita 1→2 e recuperação de migração interrompida. Pergunta foi criada com execução dublada; nenhum ambiente/disco real. Não prova rolling update nem migração universal de sessões/discos.
- Pendência v2: reconstrução Git-remoto não é demonstrada por E26/E33; substituição de sessão MVP ainda exige ambiente preservado. Rotação temporal Lambda, SSH/WebSocket, Docker e rede exigem evidência própria.

## 8. Seam recomendado como HIPÓTESE e alternativas

- **H1 — refinar Workers existente:** adaptar harness/sessão/eventos/perfis dentro dessa fronteira; manter Protocol/Records e projeção Sandbox, sem registry de plugins nem outro supervisor. Primeiro candidato: SDK com built-ins vazios e MCP explícito.
- Custo H1: schemas/recibos multiharness, tradução de tools/contexto, eventos/uso, controle de recursos, suspensão e compatibilidade. Sem promessa de que será uma mudança pequena.
- **H2 — CLI headless + MCP externo:** mesmo seam Workers, menos callbacks in-process, mais composição/observação de subprocessos e protocolos. Pode servir se SDK não satisfizer enquadramento ou semântica; não é automaticamente mais isolado.
- **H3 — hooks com tools nativas:** investigar somente se trouxer vantagem concreta; encaminhar Bash/Read nativos pode vazar host e bruto antes do filtro. Hook não deve virar substituto implícito da fronteira Sandbox.
- **H4 — loop Claude dentro do guest:** muda pressuposto aprovado de workers/sessões no host, localização de credenciais/persistência e morte do loop na rotação. Alternativa para decisão do operador se H1/H2 falharem, não autorizada pela pesquisa.
- Contrato mínimo do harness: executar papel/perfil explícito, sessões identificáveis/substituíveis, entregar resultados, observar evidência/uso/erro, interromper e cooperar com cessação. Contrato mínimo do guest: ferramentas confinadas, observação/parada, Git e ambiente reconstruível com identidade de boot.
- Capacidades são da **combinação**: read-only técnico, streaming, cancelamento, contexto multimodal, Docker, duração, rede e transporte. Docker pode ser dispensável para repo; read-only/cessação não podem ser dispensados para acomodar harness.
- Dependências H1: Node/SDK/binário e login nativo no host; MCP confiável com projeção mínima; transporte ao guest; assets/instruções versionados; observabilidade de processo/background. Guest não recebe chave emissora GitHub App nem credencial do modelo por necessidade presumida.

## 9. Recuperação sem migração de conversa

- Parar → confirmar cessação/reconciliar efeitos → alterar configuração → reiniciar sequencialmente; registrar perfil efetivo por Execução. Nenhuma Execução muda de harness; sem comando de troca ou roteamento por quota.
- Contexto mínimo independente do transcript: pedido e instruções versionados/referenciados; identidade Trabalho/Execução/boot; repo/base/branch e OIDs remotos confirmados; perguntas/respostas, autorização de escopo, pareceres completos/rodada, gates ligados ao conteúdo e efeitos pendentes/ambíguos.
- Fornecer referências/trechos autorizados pelo controlador, não resumo semântico do código nem transcript convertido. Resumo do executor é auxiliar; ausência após crash não pode impedir recuperação.
- Com ambiente preservado, comparar perfil/sessão e estado antes de continuar; com ambiente perdido, reconstruir do `origin`, registrar perda desde último push e abrir sessão substituta quando necessário, preservando antiga como evidência.
- Direção01 exige WIP commit + push antes de pergunta humana e gate remoto: workspace limpo incluindo untracked não ignorados, ausência de stash e HEAD correspondente à branch efetivamente publicada no origin (não apenas tracking ref local). Esse gate é independente da tool `ask_user`. Falha ao publicar mantém impedimento, não “espera humana segura”; arquivos ignorados precisam ser reconstruíveis e segredos não podem ser publicados.
- Implementação/revisão/publicação no mesmo boot; rotação antecipada impede novas chamadas longas, publica, verifica gate, cessa e reconstrói. Não depender só de termination hook nem propor S3/bundle/workspace host obrigatório.
- Prova local pode reconstruir um clone e contexto para testar essas regras sem esperar Lambda; isso não homologa transporte, duração, rede ou capacidades do serviço.

## 10. Cenários de entrada para ticket06

| Cenário | Oráculo e evidência exigida |
| --- | --- |
| T1 — três papéis | Claude Builder + Standards + Spec isolados e combinados; modelo/perfil registrado; dois pareceres reais; zero turnos/tools Builder durante revisão, depois entrega e consumo distinguíveis |
| T2 — superfície mínima | Inventário efetivo sem built-ins, MCP extra/plugins/connectors; tentativa adversarial Bash/Edit/Read host falha; revisor só lê via backend confinado, incluindo symlink/traversal e novos arquivos |
| T3 — suspensão | Handoff seguido de batch/tool/inferência/background; demonstrar bloqueio antes de efeitos e pedido de modelo; avaliar `defer` versus encerrar/retomar sem assumir equivalência |
| T4 — pergunta | Conteúdo persistido antes ACK; WIP/push/gate antes espera; crash antes/depois ACK, nenhuma Promise esperando humano nem Slot livre com atividade; resposta só por nova admissão |
| T5 — segredos/transcript | Segredo-canário partido em chunks, erros, imagem/arquivo, MCP progress e logs; ausência antes de modelo e persistência nativa; falha do filtro não libera bruto |
| T6 — cessação | Cancelar/crash/desconectar em tool e background; inventariar worker/binário/descendentes/MCP/guest; só liberar capacidade e admitir substituto após cessação confirmada |
| T7 — continuidade | Pi→Claude e Claude→Pi no mesmo Trabalho, parada/reconfiguração/reinício; mesmo histórico/limites, sessão substituta e contexto suficiente sem transcript anterior |
| T8 — preservado versus perdido | Reusar sessão compatível versus clone remoto novo, morte antes push, efeito GitHub ambíguo e rotação planejada; perdas explícitas e nenhum replay cego |
| T9 — perfil/auth/quota | Perfil dedicado, settingSources/managed policy, MCP/instruções efetivos; login nativo expirado, API key ambiente e quota indisponível; diagnóstico sem fallback, consumo indisponível ≠ zero |
| T10 — revisão/upgrade | Um parecer completo e outro cortado; preservar o válido e admitir reposição autorizada; reconfiguração com pergunta pendente e incompatibilidade detectada antes de mutação |

- Ticket06 deve fixar versões/fontes, ambiente/repo descartável, orçamento/prazo, credenciais autorizadas, falhas permitidas e cleanup. Classificar cada critério aprovado/reprovado/inconclusivo; mocks não substituem fronteira Claude real.
- Falta de quota/login válido torna critério dependente inconclusivo, não compatível nem incompatível. Critério obrigatório sem evidência impede aceite; demonstração local não homologa Lambda.

### Critérios transversais da prova

- Hooks de guarda devem declarar comportamento em falha: [C8] documenta default que pode prosseguir e `onFailure: "block"` para bloquear; requer SDK TypeScript **v0.3.317+**. Não confundir falha de callback com negação.
- Evidência deve registrar inventário de ferramentas e configuração efetivamente resolvidos, não apenas opções solicitadas.
- Capturar início/fim de pedidos de modelo e operações de ferramenta para distinguir suspensão observada de simples silêncio do stream.
- Para T5, inspecionar persistência nativa e arquivos auxiliares no perfil descartável, sem converter transcript em banco de domínio.
- Para T6, MCP remoto ou transporte desconectado com resultado incerto exige reconciliação; matar apenas o cliente não comprova ausência de efeito guest.
- Para T8, demonstrar remoto confirmado antes da reconstrução; igualdade de path ou SHA local não comprova publicação.
- Nenhum resultado desses cenários autoriza executar o próximo: autorização de ambiente, consumo e cleanup precede o ticket de protótipo.

## 11. Riscos/gaps e decisões reservadas ao Operador

- **Gaps principais:** suspensão sem novas inferências; ordem pré-transcript; isolamento efetivo de tools/config; cessação de MCP/background; reconstrução hoje recusada pelo MVP; enquadramento de assinatura. São perguntas de prova, não incompatibilidades já concluídas.
- Sem necessidade de nova decisão para escrever ticket06 dentro da direção04. Voltar ao operador se a hipótese exigir loop no guest, ampliar reviewer além de read, aceitar gravação bruta, relaxar cessação/confinamento ou manter writers concorrentes.
- Confirmar enquadramento/termos e auth antes de usar assinatura; API paga, novos métodos de credencial, fallback ou alteração do binário não estão implicitamente autorizados.
- Escolha SDK versus CLI e composição final só após evidência e decisão de viabilidade; Lambda continua trilha própria convergindo no ticket08. Não alterar MVP para disfarçar ausência de capacidade.
- Este relatório entrega localização do seam e hipóteses testáveis. Resolução do ticket05 e atualização de mapa/status pertencem à validação documental/aprovação do supervisor, não a esta escrita.
