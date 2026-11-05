# Definir o pacote de skills e o contrato verificável de revisão e validação

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a3eb-7f7c-72a8-8dc8-48f32b2b74fc`; branch `software-factory-skills-review`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-skills-review`. Destino de integração: `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`; sem publicação de `main`. Decisão HITL confirmada em duas rodadas. Recursos de registros históricos, removíveis após integração e validação.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 06, 07, 10, 16

## Question

Como distribuir e executar implement, code-review, /pr e suas dependências no perfil próprio da fábrica,
com evidências verificáveis de revisão e validação, sem depender de recursos globais do operador?

Definir formato/distribuição versionada do pacote, inclusão explícita das instruções no SDK e integração com as ferramentas da fábrica.
Aplicar o [contrato de captura da especificação](16-specification-snapshot-contract.md#answer) à skill `implement`:
concretizar layout/registro das fontes nos artefatos do Trabalho, disciplina de captura completa e consulta pelos revisores,
com escrita direta pelo Builder, sem coletor, ingestão ou validador documental no controlador.
Distinguir cópias da especificação de snapshot da worktree, cuja exigência continua retirada.
No fluxo de revisão, adaptar apenas o ponto de implement/code-review ao **handoff mínimo ao controlador aprovado**:
Builder sinaliza que está pronto e devolve o controle; controlador reutiliza o mecanismo de workers para disparar Standards/Spec
em paralelo na mesma VM e mesmo workspace do Trabalho, depois fornece os dois resultados à sessão existente do Builder.
Builder não executa durante a revisão; o host fornece execução, permissões e registros. Não exigir VM auxiliar, snapshot próprio,
commit candidato obrigatório ou gate de worktree limpa/quiescência para iniciar reviews.
Cobrir integralmente as alterações propostas, inclusive não commitadas e arquivos novos, com ferramentas de revisão sem escrita;
concretizar apenas o encaixe desse handoff no perfil independente da fábrica, sem alegar workspace imutável.
O Pi coding-agent não inclui ferramenta nativa pronta de subagentes. A escolha final evita essa dependência:
não exigir extensão/pacote de delegação, ferramenta genérica de subagentes ou segundo motor de workflow.
Configurar os revisores pelo mesmo mecanismo SDK de workers, com sessões próprias, ferramentas guest somente leitura,
modelos por papel, resultados/falhas e cancelamento, sem herança do perfil pessoal.
Definir resultados de ambos os revisores, correlação com conteúdo/spec/perfil, tratamento dos achados pelo Builder,
falha de execução, invalidação por alterações posteriores e condição para solicitar nova revisão.
Aplicar o [contrato de prontidão](10-readiness-checks-contract.md#answer): preferir retomar a sessão própria compatível de cada revisor
nas novas rodadas de implementação/reparo, com histórico, referências atualizadas, mudanças e achados/tratamentos anteriores.
Cada revisor escolhe análise incremental ou ampla, mas emite parecer atual explícito e justificado para o resultado proposto;
não reutilizar aprovação antiga automaticamente nem dispensar cobertura integral. Sessão indisponível/incompatível exige
substituição com contexto suficiente, revisão completa ou bloqueio, sem aprovar por falta de memória.
Mero avanço da base com PR apto não dispara revisão ou Execução; não criar watcher de base, cache semântico ou fila avulsa de reviews.

Definir como identificar gates do repositório, registrar comandos/status/resultados e tratar ausência de instrução,
validação não executada, falha e dispensa humana via ask user, sem contornar checks obrigatórios do GitHub.
Distinguir carregar uma skill de cumprir seu contrato e conclusão do agente de prontidão do PR.
/pr redige a descrição; a publicação continua direta pelo Builder conforme a autoridade aprovada.

Não redesenhar runtime, isolamento, fila ou protocolo de transporte, nem construir o pacote/adaptador ou rodar provas.
A decisão deve deixar claros os contratos que o controlador verifica e as provas futuras necessárias.

## References

- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md): SDK, ferramentas e coordenação dos dois workers.
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md): mesma VM, ferramentas sem escrita e diretriz de evitar orquestração acidental adicional.
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md): especificação e instruções usadas na revisão.
- [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md): uso posterior das evidências, sem substituir checks por dispensa.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): transporte e recuperação das evidências.
- [PRD — Software Factory MVP](../prd.md): RF-05–08, RF-10, RNF-02/03/05 e CA-01/12.

## Comments

- Rodada HITL inicial: operador aprovou Q1–Q5 seguindo as recomendações e Q6 com ressalva explícita de legibilidade dos PRs.
  Q1–Q6 cobriram pacote próprio, carregamento explícito, aprovações das skills, layout documental, pareceres/achados e gates.
- Ressalva literal do operador em Q6: “meu único receio é gerar PRs muito grandes, detalhados, quando na verdade deveriam ser resumidos e de fácil leitura pelo ser humano”.
- Segunda rodada HITL: operador confirmou “de acordo com as recomendações” para Q7–Q10:
  apresentação curta do PR, identidade leve do conteúdo revisado, novas rodadas após correções e recuperação de falha parcial.
  Q9 inclui a exceção explícita de criar o commit com exatamente o conteúdo já revisado, sem ciclo de revisão por esse ato.
- Resolução consolidada no Answer abaixo. Somente este ticket não-research foi resolvido nesta sessão;
  nenhuma skill, ferramenta, sandbox ou agente da fábrica foi implementado/executado.
- Validação documental: `git diff --check`; 22 tickets com status/tipos/labels/Answers e dependências consistentes,
  grafo sem ciclos, índice do mapa conferido e 238 referências locais existentes. Probe LSP dos três Markdown alterados
  sem erros/avisos. Essas verificações não são provas de execução do MVP.

- Graduado da névoa após a definição de workers de revisão coordenados pelo host e de recursos próprios da fábrica.
- Ticket de decisão HITL; não é autorização para implementar skills ou executar revisores.
- Escopo atualizado pela resolução de [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md#answer):
  sessões e pareceres incrementais explícitos, sem revisão causada apenas por avanço da base. Este ticket continua aberto.
- Esclarecimento solicitado pelo operador sobre suporte nativo: [README Pi fixado](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/README.md) declara que subagentes não vêm prontos no core; [SDK](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/sdk.md) fornece sessões/ferramentas configuráveis. Há [exemplo oficial de extensão](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/examples/extensions/subagent/README.md) com subprocessos CLI e execução paralela; não é prova da integração SDK/Gondolin escolhida. O ambiente interativo atual usa pi-subagents adicional. Esse fato motivou a escolha posterior do handoff ao controlador, em vez de adotar uma extensão de subagentes. Não reabrir a seleção de pacote de delegação nem relançar pesquisa geral de runtimes como pressuposto deste ticket.
- Atualizado pela aprovação final do operador durante a decisão de isolamento: handoff ao controlador para dois reviewers em paralelo e devolução de resultados ao Builder, reutilizando workers existentes; substitui a diretriz intermediária de orquestração pelo próprio Builder. A exigência adicional de snapshot/referência imutável foi retirada; não reintroduzi-la como premissa deste ticket. Permanecem cobertura integral, dois objetivos, revisão sem escrita, resultados/falhas e invalidação após mudanças relevantes.

## Answer

### Pacote próprio e inclusão explícita

Distribuir as skills como arquivos versionados junto de cada versão da fábrica, no seu repositório.
Partir de cópias adaptadas de `implement`, `code-review`, `pr` e `tdd`, incluindo dependências e referências locais aplicáveis.
A dependência de `tdd` em `codebase-design` e seus documentos auxiliares deve estar disponível quando aplicável;
referenciar um recurso não autoriza depender de uma instalação global do operador.
A skill de preparação/diagnóstico do guest foi acrescentada por decisão posterior no
[contrato do adapter Gondolin](19-gondolin-adapter-contract.md#imagem-dependências-e-persistência); incorporar suas orientações ao mesmo pacote, sem gerenciador de ambientes adicional.
Registrar origem, versão e identidade dos arquivos em manifesto simples do pacote/perfil, preservando créditos/licenças aplicáveis.
Atualizações são mudanças explícitas da fábrica, sem registry próprio, instalador de skills ou sincronização automática com o perfil pessoal.

O perfil SDK resolve explicitamente `/implement <link-ticket>` e `/pr` para o conteúdo das respectivas skills.
Política essencial e instruções do papel entram no contexto; dependências e referências auxiliares ficam disponíveis para leitura em caminhos conhecidos.
Não presumir que mencionar o nome de uma skill a executa ou que existe uma ferramenta nativa `Skill` nesse perfil.
Registrar a identidade dos recursos carregados, sem tomar carregamento como prova de cumprimento.
Não herdar skills, plugins, templates, settings ou credenciais pessoais ou executáveis descobertos no repositório.

Adaptar o ponto de revisão de implement/code-review ao handoff já aprovado, não transportar literalmente a delegação da skill pessoal.
A versão da fábrica não usa somente `git diff <base>...HEAD`, não omite Spec por falta de fonte e não exige pacote genérico de subagentes.
Manter os dois objetivos e as referências de Standards, distinguindo regra documentada de heurística de qualidade;
heurísticas não são violações obrigatórias e não prevalecem sobre padrões explícitos do repositório.

### Aprovações e fontes preservadas

Manter as aprovações humanas exigidas pelas skills. Reutilizar aprovação explícita registrada que cubra concretamente a decisão;
quando ausente, usar `ask user`, inclusive para confirmar as interfaces de teste exigidas por `tdd`.
A label de entrada não substitui essas aprovações. Não introduzir aprovação adicional quando a exigência já estiver satisfeita.

Aplicar a responsabilidade e os limites de
[Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md#answer).
Dentro do diretório de artefatos do Trabalho, fora das alterações destinadas ao PR, usar:

```text
spec/<versão>/
  <cópias das fontes>
  sources.json
instructions/<versão>/
  <cópias das instruções>
  sources.json
```

O Builder escreve diretamente as cópias e, por último, o `sources.json` completo, com origem, caminho da cópia,
data de consulta, hash e commit/revisão quando disponível. Versões anteriores não são sobrescritas.
Registro ausente/incompleto significa captura a recuperar, não especificação pronta para revisão.
Spec consulta a versão preservada do pedido; Standards consulta as instruções aplicáveis, não versões atuais presumidas dos links.
Fonte necessária inacessível ou contexto insuficiente exige `ask user`; não autoriza omitir o revisor.
Não acrescentar coletor, API de ingestão ou validador documental ao controlador.
O registro não prova descoberta exaustiva de fontes nem imutabilidade contra código hostil.

### Handoff, cobertura e identidade do conteúdo

O Builder pede revisão e devolve o controle; o controlador usa os workers existentes para iniciar Standards e Spec em paralelo,
com sessões/modelos próprios, mesma VM/workspace e ferramentas guest somente leitura.
O Builder não executa durante as revisões e o Slot permanece ocupado. Permissões efetivas, não apenas instruções ao modelo,
impedem escrita dos revisores; não fornecer shell irrestrito nem credencial GitHub de escrita.
O conjunto concreto de acesso a contexto e a entrada do handoff foram simplificados no
[contrato do adapter Gondolin](19-gondolin-adapter-contract.md#revisores-somente-read-e-contexto-da-rodada).
Aplicar essa decisão no perfil/skills, sem reintroduzir shell, wrappers especializados ou consultas remotas por conveniência.
O host registra os resultados efetivos dos workers e os devolve à sessão existente do Builder.
Transporte, ownership e recuperação seguem o protocolo próprio, sem segundo motor ou plataforma de delegação.

A cobertura é o resultado integral proposto: alterações commitadas, staged, não staged e arquivos novos destinados ao PR,
incluindo remoções e demais mudanças Git relevantes. Arquivos não rastreados não podem desaparecer da análise por omissão do diff.
Revisores podem consultar arquivos/contexto além dos hunks; o resumo do Builder não substitui inspeção.
Artefatos operacionais, dependências e arquivos gerados que não integram a proposta não são automaticamente mudanças do PR;
a identidade revisada deve corresponder ao que for efetivamente publicado.

Registrar referências Git/base de comparação e identificação leve dos caminhos/conteúdos propostos por hashes,
incluindo presença/remoção e metadados Git relevantes à mudança, junto das versões de especificação, instruções e perfil.
Esse registro identifica a entrada dos pareceres, não guarda uma cópia/snapshot da worktree nem calcula equivalência semântica.
Não exigir commit candidato, worktree limpa, VM auxiliar ou auditoria genérica de quiescência.
Não prometer congelar o workspace contra escritores externos. Mudança observada durante a análise impede considerar o parecer
válido para o resultado final sem nova avaliação; identidade incerta não equivale a correspondência comprovada.

### Pareceres, achados e tratamento

| Registro | Conteúdo necessário |
| --- | --- |
| Identidade da rodada | Trabalho, Execução, rodada/tentativa, papel, sessão e perfil/modelo utilizados |
| Entrada examinada | Referências e identidade do conteúdo, versões de especificação/instruções e contexto anterior aplicável |
| Resultado efetivo do worker | Concluído, falha ou cancelamento, com motivo; falha não equivale a zero achados |
| Parecer concluído | Cobertura, análise incremental/ampla e justificativa, conclusão atual e achados identificáveis por eixo |
| Achado | Local/contexto, regra ou requisito correspondente e motivo; distinguir heurística de violação documentada |
| Tratamento pelo Builder | Referência ao achado, corrigido ou não acolhido com justificativa e evidência/contexto pertinente |

Standards e Spec permanecem separados; um resultado não encobre o outro.
Não exigir aprovação sem ressalvas ou transformar todo achado em veto automático.
O Builder decide como tratar achados, mas não fabrica, omite ou dispensa a conclusão dos revisores.
Discordância não exige arbitragem humana por si só; dúvida de requisito, autorização ou dispensa exige `ask user`.
Justificativa não autoriza descumprir o pedido nem dispensar gates/checks obrigatórios.

Preferir retomar as sessões próprias compatíveis, fornecendo mudanças, referências e achados/tratamentos anteriores.
Cada revisor determina a profundidade necessária e emite conclusão atual justificada, preservando cobertura integral.
Sessão indisponível/incompatível exige substituição registrada, contexto recuperável e revisão completa quando necessária;
contexto insuficiente produz bloqueio, nunca aprovação por falta de memória.

### Correções, publicação e falha parcial

Depois de alterar o conteúdo para corrigir achados, o Builder reúne as correções e pede outra rodada de ambos os revisores.
Não disparar revisão a cada edição nem reutilizar automaticamente aprovação antiga após mudança relevante.
Alterações do pedido, instruções ou perfil que afetem a análise exigem avaliação no contexto atualizado, sem adoção silenciosa.
Mero avanço da base com PR apto continua sem disparar revisão ou Execução.

Duas situações não causam rodada por si só:

- Registrar justificativa de não acolhimento fora do conteúdo do PR, sem mudar o pedido ou o contexto examinado.
- Criar o commit que contém exatamente o conteúdo já revisado: vincular a identidade examinada ao commit publicado,
  sem ciclo infinito de revisão causado pelo ato de commit. Não aceitar apenas a declaração do Builder de que são iguais.

A segunda exceção foi explicitamente aprovada em Q9 e esclarece a referência genérica a mudanças de commits do
[contrato de prontidão](10-readiness-checks-contract.md#answer).
Ela não dispensa nova avaliação de alterações efetivas, rebase/reorganização que mude o contexto examinado,
conteúdo humano não reconciliado ou correspondência incerta. Não criar cache semântico para decidir equivalência.
Checks do GitHub continuam correlacionados ao SHA pertinente; parecer sobre conteúdo não empresta CI de commit antigo.

Se apenas um revisor falhar operacionalmente, preservar o parecer concluído e recuperar somente o que falhou,
quando conteúdo e contexto continuarem os mesmos. Usar os limites operacionais já definidos, sem novo orçamento paralelo de retries.
Se o Builder alterar a proposta, ambos passam pela nova rodada normal.
Esgotamento das tentativas produz bloqueio; não converter falha em achados vazios.
Cancelamento interrompe os workers associados e preserva registros, sem promover resultado parcial a revisão completa.
Ownership, efeitos ambíguos e interrupção efetiva continuam sujeitos à reconciliação do controlador.

### Gates e fronteira de verificação

O Builder identifica gates e fontes aplicáveis: testes, typecheck, lint e demais validações documentadas.
Registrar comando, diretório, resultado/status e referência ao log da execução efetiva, correlacionados ao conteúdo e à Execução.
Distinguir sucesso, falha e não execução; stdout declarado pelo agente não substitui o resultado real da ferramenta.
Mudança posterior que torne a evidência inaplicável exige validação atual, não reaproveitamento automático do verde anterior.

Falta de instruções, impossibilidade de execução ou falha não resolvida exige orientação por `ask user`.
Dispensa humana tem escopo, autoria e resposta correlacionada registrados; nunca substitui check obrigatório do GitHub.
Alterar instruções do próprio repositório não concede ao Builder poder de dispensar seus gates.

O controlador verifica presença e correlação das evidências efetivas: ambos os resultados, conteúdo/contexto,
tratamento registrado dos achados, gates e dispensas autorizadas aplicáveis. Não interpreta toda a documentação,
não certifica semântica do pedido e não audita o conteúdo de cada fonte capturada.
Conclusão do agente, skill carregada, review concluído, PR aberto e prontidão são condições distintas.
A avaliação final de prontidão permanece no [contrato de prontidão](10-readiness-checks-contract.md#answer).

### PR curto para leitura humana

`/pr` prepara a descrição; publicação continua direta pelo Builder e abertura como draft conforme a autoridade já aprovada.
Adaptar o template para três partes curtas:

- **Resumo:** o que mudou, por quê e vínculo ao ticket.
- **Validação:** síntese das verificações e limitações/dispensas relevantes.
- **Risco:** somente o que merece atenção do revisor humano.

Não publicar transcrições, listas extensas de comandos, histórico de rodadas ou pareceres integrais no corpo/comentários do PR.
Detalhes permanecem nos artefatos/histórico do Trabalho; links para evidência só quando houver destino acessível.
Não apresentar caminho local como link útil ao leitor remoto nem criar serviço de publicação de artefatos para cumprir essa regra.
Diagramas e exemplos são opcionais, usados apenas quando simplificam a leitura; não exigir imagem ou antes/depois artificial.
Uma limitação importante deve aparecer na síntese, não ficar escondida nos logs.
Preservar evidência detalhada não obriga o humano a lê-la para entender o PR.

### Provas posteriores e encaminhamentos

| Cenário a demonstrar | Resultado exigido |
| --- | --- |
| Perfil pessoal ausente ou divergente | Mesmas skills/dependências fixadas; nenhum recurso pessoal herdado |
| Skill carregada, mas revisão/gate não executado | Evidência ausente; nenhuma prontidão presumida |
| Interface de teste sem aprovação aplicável | ask user; aprovação prévia concreta é reutilizada sem pergunta redundante |
| Crash antes do sources.json completo | Recuperar captura; Spec não usa versão incompleta como pedido concluído |
| Mudanças staged, não staged, arquivo novo ou remoção | Cobertura integral e identidade compatível com a publicação |
| Tentativa de escrita pelo revisor | Negada efetivamente pelo ambiente/ferramentas, não só pelo prompt |
| Conteúdo muda durante/depois da análise | Parecer antigo não certifica resultado novo; nova avaliação |
| Commit contém exatamente a proposta revisada | Vincular identidade ao commit sem rodada só pelo ato de commit; CI atual continua obrigatório |
| Correção após achado, com sessões preservadas | Ambos emitem parecer atualizado, incremental/amplo justificado |
| Um revisor falha com outro concluído | Retry apenas do falho se entrada inalterada; limites existentes e bloqueio ao esgotar |
| Não acolhimento justificado, sem mudar proposta | Tratamento registrado; sem veto/arbitragem/rodada automática só pela discordância |
| Gate não executado ou dispensado, check GitHub obrigatório pendente | Não inventar sucesso nem contornar check |
| Muitos logs e várias rodadas | PR continua curto, com limitações importantes visíveis e detalhes separados |
| Cancelamento ou sessão incompatível | Registros preservados e recuperação explícita; nenhuma aprovação parcial presumida |

Testar contratos de registros/correlação com simulações e demonstrar posteriormente SDK, ferramentas somente leitura,
retomadas e publicação em ambiente autorizado. Esta decisão documental não executou essas provas nem aceitou o MVP.
Cobertura: RF-05–08, RF-10, RF-13, RNF-02/03/05 e CA-01/05/06/12, sem substituir os demais critérios do PRD.

Encaminhamentos já cobertos por tickets abertos; não duplicar decisões nem abrir tickets de implementação:

- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): transportar/correlacionar handoff, resultados, falhas e evidências reais.
- [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md): disponibilizar pacote/artefatos e ferramentas com restrições efetivas.
- [Definir o fluxo de manutenção e reconciliação autorizada do PR](20-pr-maintenance-contract.md): consumir pareceres e evidências atuais sem expansão do corpo do PR.
- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md): distribuir o perfil e suas versões explicitamente.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md): manter evidência detalhada consultável e protegida, separada da apresentação humana.

A névoa de provas de aceite e revisão cruzada da arquitetura permanece no mapa; esta decisão não encerra essas etapas.
