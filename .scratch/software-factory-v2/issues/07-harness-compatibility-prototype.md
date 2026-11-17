# Validar Pi e Claude Code nos contratos de execução e continuidade

Status: resolved
Assignee: Operador, assistido pelo Pi nesta sessão
Claim context: branch prototype/v2-harness-proof, worktree .worktrees/harness-proof-run/; destino documental main no checkout principal, inicialmente em 0a8b9c61eaf8cb9fd62c3e5a3a9ae6c8c94221be. Referência MVP imutável aabe06abfb20e83593020c0fee19b078d235466b. Claim e campanhas históricos preservados em Comments; resolução desta retomada após aprovação explícita do Operador.
Type: prototype
Label: wayfinder:prototype
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 06

## Question

Pi e Claude Code cumprem os contratos exigidos e permitem continuar o mesmo Trabalho após parada,
reconfiguração e reinício, sem migrar transcripts nem enfraquecer isolamento e recuperação?

## Authorization gate

Marcar claimed antes de trabalhar. Antes de executar, obter autorização específica conforme a
[spec da prova](06-harness-proof-spec.md): ambiente, conta/assinatura, permissões, limites de consumo,
prazo/custo e cleanup. Não inferir essa autorização da direção aprovada ou do fechamento da spec.
Não usar credenciais de terceiros, código privado ou serviços reais fora do escopo autorizado.

## Comments

- O Operador aprovou avançar para a prova local: até 60 minutos de execução real, 20 ativações,
  um Builder e até dois revisores, sem repetição automática; ambiente/Git descartáveis, sem AWS
  ou GitHub real, parada em violação/limite/perda de controle e cleanup próprio. Escolheu OpenAI
  gpt-6-luna no Pi. Modalidade OpenAI e eventual teto monetário ainda devem ser esclarecidos;
  nenhum fallback pago está autorizado. Perfil exato e gates serão conferidos antes da inferência.
- A integração MVP avançou após a spec; sua worktree existente não será alterada nem tomada como
  nova referência automaticamente. Usar somente o SHA fixado para leitura do código de referência.

- Autorização complementar recebida: Pi OpenAI por assinatura/OAuth oficial e dependências somente
  locais. Claude também exclusivamente subscription. Operador autorizou perfil Claude pessoal pelo
  binário oficial, sem copiar tokens, registrando limitação de isolamento e sem logout/remoção no
  cleanup; selecionou Haiku para reduzir quota. Handshake resolve claude-haiku-5-5, sem inferência.
- [Resultado parcial do primeiro bootstrap](../research/harness-proof-results.md): Sandbox recusou
  root longo antes do boot (SANDBOX_RUNTIME_PATH_TOO_LONG); zero ativações. Cessação not-booted
  confirmada. Código descartável vive nesta branch, não será incorporado ao MVP.
- Operador autorizou runtime curto em /home/sanmoo/sfhp-v2 e novo bootstrap. VM iniciou, perfil
  efetivo Haiku/subscription/MCP mínimo foi observado; primeira ativação recebeu rate_limit nativo
  por limite de cinco horas. Runner inicialmente confundiu mensagem sintética com MODEL_DRIFT;
  diagnóstico corrigido, com teste determinístico e sem nova inferência. Uma ativação tentada,
  nenhuma inferência bem-sucedida. Não repetir automaticamente nem usar API paga. C1–C12 inconclusivos.
  Cessação e remoção de disco/workspace/artifacts/runtime do root curto confirmadas pelo Sandbox;
  metadados, snapshot e branch/worktree preservados. Ticket não resolvido.

- Nova retomada autorizada: consulta mínima Haiku confirmou quota disponível. Builder real corrigiu
  fixture e executou teste guest (captura contém 5 0/PASS), mas consultas Git falharam porque a fixture
  não era repositório. maxTurns 4 interrompeu a ativação antes da revisão. Diagnóstico/preparação Git
  corrigidos no runner, sem repetir modelos. Três ativações acumuladas, 17 remanescentes. Processo/VM
  cessados e recursos de boot removidos pelo Sandbox. [Evidência da retomada](../research/harness-proof-attempt-3.json).
  C1 parcial, nenhum critério obrigatório integralmente aprovado; ticket continua claimed.

- Repetição J1 autorizada: após ajustar fixture ao safe.directory já existente do guest, quatro
  ativações Haiku reais completaram. Builder corrigiu/testou a tarefa, mas revisores receberam vazio
  porque o bridge não paginava a captura protegida. Ambos FAIL por falta de evidência, não pareceres
  válidos. [Evidência da tentativa](../research/harness-proof-attempt-4.json). Correção de paginação
  com oito testes determinísticos passou; check real sem modelos teve timeout de readiness no
  segundo boot. Sem repetir inferência após diagnóstico. Total 7 ativações, restam 13. Recursos
  de ambos os boots removidos pelo Sandbox com cessação confirmada. J1 e prova não aprovadas;
  C1 parcial e ticket permanece claimed. MVP intacto, sem push nem integração do código descartável.

- Operador autorizou autonomia para correções pequenas de preparação/ensaio, sem novas perguntas;
  manter confirmação somente para ampliar custo/permissões, mudar hipótese, atingir limites ou
  violação/perda de controle. Essa autorização não elevou o teto nem permitiu API paga.
- Campanha limitada encerrada em 20 ativações: [síntese e matriz por critério](../research/harness-proof-summary.md).
  Claude nos três papéis e pareceres válidos; WIP/pergunta/retomada locais; Pi→Claude→Pi com origin
  real, clones novos e sessões distintas, sem transcripts. Controle/contabilidade e efeito incerto
  continuam fixtures. Perfis mistos Pi reviewer e cancelamento em tool não têm prova suficiente;
  aceite global INCONCLUSIVO. Uma reserva falhou antes de qualquer sessão/request e foi liberada,
  sem restituição presumida de quota. Não executar novas inferências nesta campanha.
- [Cleanup verificado](../research/harness-proof-cleanup.json): nove ambientes observados removed
  com cessação confirmada, 16 sessões Claude próprias removidas via SDK oficial e perfis temporários
  próprios removidos, sem logout ou remoção de credenciais/sessões pessoais alheias. Dependências,
  snapshot, metadados e branch/worktree preservados. Nenhuma alteração do MVP, push ou integração.
  Ticket permanece claimed, tanto pelas lacunas quanto pelo limite de uma resolução nesta sessão.

- Retomada exclusiva deste ticket autorizada pelo Operador nesta sessão: nova rodada de até 10
  ativações e 30 minutos de execução real, separada da campanha encerrada em 20 ativações.
  O Operador ofereceu flexibilidade adicional; o runner mantém 10/30 como teto operacional e
  eventual ampliação será explicitada antes de consumir além dele. Preparação/oráculos sem modelos
  precedem inferência; foco em cancelamento durante ferramenta, perfis mistos Pi habilitados e
  lacunas de suspensão/confinamento/filtragem. Sem repetir casos já demonstrados sem razão técnica.
  Mesma branch/worktree e destino documental; resultado será apresentado para aprovação antes
  de resolver este ticket ou atualizar o mapa. Sem push, MVP ou novas frentes.

- Rodada complementar encerrada em dez ativações novas, separadas das 20 anteriores: [proposta de
  veredito e matriz C1–C12](../research/harness-proof-complement-summary.md). Cancelamento em tool
  real com cessação antes do substituto, ambos os perfis mistos completos e cobertura dirigida de
  confinamento. Proposta: C1/C2/C4/C7/C8/C10/C11 aprovados no recorte local; C3/C5/C6/C9/C12
  inconclusivos; conjunto INCONCLUSIVO. Débito conservador final de cinco minutos, sem ampliar teto.
  [Evidência sanitizada](../research/harness-proof-complement.json) preserva falhas de preparação e
  erro inicial do scan Claude, corrigido na décima ativação. [Cleanup auditado](../research/harness-proof-complement-cleanup.json):
  cinco ambientes removed/cessationConfirmed, oito grupos Claude vazios, seis sessões Claude
  ausentes por helper oficial e oito diretórios Pi ausentes, sem tocar credenciais/sessões alheias.
  Aguardando aprovação do Operador: não resolver, atualizar mapa ou integrar código descartável.
  Branch/worktree existentes preservadas, destino documental main mantido, sem push.

- Após concordância do Operador com revisar aceite e investigar suspensão, foi feita uma
  [revisão sem inferências](../research/harness-proof-acceptance-review.md): zero prompts,
  processos nativos ou boots novos. Spec aceita suspensão por encerramento e registros de teste;
  auditoria da linha do tempo e dos registros retidos sustenta reclassificar C3 e C9 para aprovados
  somente no recorte local. Proposta atual: nove aprovados, C5/C6/C12 inconclusivos, conjunto ainda
  INCONCLUSIVO. A interpretação anterior e as evidências continuam preservadas.
  SDK fixado declara PostToolBatch antes do próximo modelo, com parada documentada; candidato
  para C6, não mecanismo já ensaiado. Plano mínimo de até três ativações Haiku/dez minutos está
  descrito no relatório, **ainda não autorizado**; nenhuma campanha foi reaberta. Mapa intacto,
  ticket claimed, resultado/resolução e integração documental ainda aguardam aprovação.

- Operador autorizou a rodada final proposta: até **três ativações Haiku e dez minutos de
  execução real**, em campanha nova, sem reabrir as anteriores. Preparação/oráculos sem modelos
  precedem pergunta com PostToolBatch, retomada com contador independente de efeito e falha de
  filtragem nativa, e falha dirigida do hook. Mesmos perfis, referência MVP, branch/worktree e
  limites de segurança; sem upgrade, API paga ou push. Resultado continua sujeito à aprovação
  antes de resolução, atualização do mapa ou integração documental.

- Rodada final encerrada em **três ativações** (33 históricas), débito conservador de cinco
  minutos: [proposta detalhada](../research/harness-proof-terminal-summary.md),
  [traces sanitizados](../research/harness-proof-terminal.json) e
  [auditoria independente](../research/harness-proof-terminal-audit.json). PostToolBatch positivo
  e onFailure block com falha dirigida efetivos; ACK/apresentação só após cessação; retomada
  correlacionada; erro OUTPUT_BLOCKED persistido nativamente sem canário bruto. Contador de e1
  ficou 1 antes/depois de ativação com ferramentas reais. Proposta fecha C5/C6 e C12 apenas nesse
  intervalo ativo observado, sem exigir Controle de produção ou idempotência universal.
  **Os runners tiveram exit 1 e a edição auxiliar RESUMED não passou**: não tratar resultado SDK
  success como tarefa concluída, nem rótulo genérico do oráculo como replay. Esse limite e a
  interpretação por critério estão submetidos à aprovação do Operador, não constituem aceite
  automático. Cleanup reobservou cinco ambientes removidos, seis grupos vazios, três sessões
  ausentes e nove caminhos auxiliares próprios ausentes. Sem quarta ativação, upgrade, push,
  MVP, logout ou recursos alheios. Ticket claimed, mapa intacto e sem integração em main.

## Scope and evidence

- Executar a spec aprovada, com repositório descartável e versões/perfis registrados. Código de
  experimento é descartável, não implementação de produção nem aprovação da interface definitiva.
- Preservar evidências por cenário, falhas e limitações; sanitizar logs e separar consumo conhecido,
  estimado e indisponível. Não contornar quota nem trocar de cobrança/harness silenciosamente.
- Demonstrar o que depende de Claude real, inclusive os três papéis, restrições e ciclo de vida.
  Evidência apenas de chamada -p, prompt de read-only ou retorno exit 0 é insuficiente.
- Demonstrar ambos os sentidos de reconfiguração no mesmo Trabalho, cessação e recuperação de
  contexto independente de sessão, sem reset de histórico/controles ou repetição cega de efeitos.
- Classificar cada critério obrigatório como aprovado, reprovado ou inconclusivo. Em desvio que
  altere desenho/permissões/custo autorizado, parar e retornar ao operador; não trocar a hipótese.
- Inventariar/remover recursos próprios e reportar resíduos. Não tocar ambientes ou processos de
  outros Trabalhos. Esta prova não homologa Lambda nem todas as combinações harness/sandbox.

## Exit criteria

Relatório reproduzível, resultados por critério e cleanup verificado. Resultado negativo/inconclusivo
é válido e deve alimentar a decisão seguinte, sem fingir compatibilidade nem implementar alternativa.
Não alterar PRD/spec do MVP ou aprovar produção a partir deste relatório.

## Answer

O Operador aprovou explicitamente o **aceite contratual local de C1–C12**, com a ressalva da edição
auxiliar não concluída, após ler o resultado final desta retomada. Aprovação registrada pela resposta
“aprovo”. Esta é a resolução canônica; as propostas, classificações intermediárias e falhas em
Comments/evidências acima são históricas e não foram apagadas.

**Resposta à pergunta:** Pi e Claude Code demonstraram os contratos ensaiados nos perfis locais
fixados: Claude nos três papéis; ambos os arranjos mistos com Pi; suspensão/cessação sob controle
externo; pergunta persistida, gate Git e retomada; continuidade Pi → Claude → Pi com sessões novas,
origin/clones e contexto explícito, sem converter transcripts. Isso aprova a prova finita, não uma
interface universal, adapter de produção ou composição com Lambda.

### Critérios e limite do aceite

| Critério | Resultado aceito | Evidência/limite |
| --- | --- | --- |
| C1 — tarefa e três papéis Claude | Aprovado local | Verificador independente e três papéis reais da campanha anterior. Não implica edição RESUMED bem-sucedida. |
| C2 — dois pareceres e consumo | Aprovado local | Relatórios distintos completos entregues/consumidos; Controle de entrega é fixture. |
| C3 — suspensão durante revisão | Aprovado local | Capacidade da ativação anterior retirada antes da barreira/revisores; não pausa com processo vivo. |
| C4 — confinamento/read-only | Aprovado local | Projeções, inventários, recusas dirigidas e filesystem preservado do perfil fixado. |
| C5 — filtragem e persistência | Aprovado local | Normal/chunks anteriores e erro nativo OUTPUT_BLOCKED, sem bruto/parcial no transcript/auxiliares próprios; somente canais habilitados. |
| C6 — pergunta/ACK/gate/retomada | Aprovado local | PostToolBatch efetivo; gate/persistência, cessação antes de ACK/apresentação e nova admissão correlacionada. Controle/resposta humana são fixtures. |
| C7 — cancelamento em ferramenta | Aprovado local | Operação guest real iniciada, cessação física antes de admitir substituto; não prova cessação/cobrança remota. |
| C8 — duas direções/sessões novas | Aprovado local | Pi → Claude → Pi, sessões distintas e reconstrução do origin, sem transcript anterior. |
| C9 — contexto/histórico/limites/consumo | Aprovado local | Registros e contadores locais preservados/auditados; não ledger de produção resistente a crash. |
| C10 — ambos os perfis mistos | Aprovado local | Tools efetivamente ativas, leituras, pareceres e retorno ao Builder nos dois arranjos. |
| C11 — perda antes de push | Aprovado local | Perda reconhecida na substituição; só remoto publicado foi recuperado. |
| C12 — efeito incerto | Aprovado no intervalo observado | Contador independente calibrado e1 1 → 1 durante ativação com ferramentas; não replay nessa janela, não idempotência geral. |

**Ressalva aprovada:** dois comandos do runner terminaram exit 1 e o subteste auxiliar de acrescentar/
publicar RESUMED não passou; o último conteúdo observado permaneceu WIP. O aceite de C12 distingue
não-replay observado de conclusão dessa edição. Não promover `success` do SDK a tarefa concluída,
exit code a veredito global ou fala do modelo a prova do artefato. O after-counter da primeira
retomada não foi retido e não pode ser reconstruído após cleanup; a aprovação usa a evidência
independente retida na última ativação, com esse limite explicitado.

### Perfil, consumo e referências

- Referência imutável MVP: `aabe06abfb20e83593020c0fee19b078d235466b`.
- Claude Code oficial 2.1.325, Agent SDK 0.3.325, Haiku claude-haiku-5-5 por assinatura nativa;
  Pi 1.5.2 / Factory v3, OpenAI gpt-6-luna por OAuth oficial; Gondolin 0.14.0 / Factory v1.
  O atalho pessoal atualizado para 2.1.326 não foi adotado: a última rodada usou diretamente a
  versão 2.1.325 já instalada, sem modificar binário, symlink ou credenciais pessoais.
- Campanhas encerradas em **20 + 10 + 3 = 33 ativações**, com autorizações separadas e sem reset
  silencioso. Nenhuma inferência adicional é autorizada por esta resolução.
- [Relatório final aceito e ressalvas](../research/harness-proof-terminal-summary.md).
- [Traces finais sanitizados](../research/harness-proof-terminal.json) e
  [auditoria independente](../research/harness-proof-terminal-audit.json).
- [Revisão de C3/C9](../research/harness-proof-acceptance-review.md) e
  [rodada complementar](../research/harness-proof-complement-summary.md) mantêm a proveniência.

Cleanup verificou cessação/remoção dos recursos próprios; dependências locais, snapshot e metadados
preservados para reprodução. Código descartável permanece na branch `prototype/v2-harness-proof`,
fora de main. O Operador autorizou branch/worktree temporária exclusivamente para a integração
documental em main, por fast-forward, excluindo protótipos/dependências/runtime e sem push.
A [proveniência da integração](../research/harness-proof-documentary-integration.md) identifica o
snapshot dos registros e a branch local que conserva o código descartável; recursos temporários
apenas documentais são removidos depois do fast-forward, sem remover a fonte original da prova.

### O que esta resolução não autoriza

Não homologa produção, Lambda, combinações não ensaiadas, oferta/intermediação de assinaturas,
replay/reconciliação geral, tarefa auxiliar RESUMED ou o runner inteiro. Não modifica PRD/spec do MVP,
não escolhe composição final e não implementa interfaces/adapters. A decisão de composição existente
no mapa deve usar estas evidências e seus limites; este ticket não é retomado como execução dessa
outra frente. A resolução não amplia custos, permissões ou orçamento de inferência.
