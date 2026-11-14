# Assinatura Claude Code na Software Factory — pesquisa documental

Data de consulta: **2026-11-14**. Escopo: documentação pública, sem login, inferência, credenciais ou experimento.
**Esta pesquisa não aprova mudança de runtime, autenticação ou arquitetura.** Não altera decisões, mapa, tickets ou código.

## Síntese

Há suporte documental atual a **Agent SDK e `claude -p` consumirem limites da assinatura quando autenticados pelo plano** [S2]. Isso não equivale a autorização genérica para uma fábrica usar assinatura como backend de inferência. As restrições de intermediação, produtos terceiros e credenciais continuam relevantes [S1, S4]. Também não cabe concluir que toda automação é proibida: a documentação ensina execução programática, e os termos de consumidor ressalvam API key **ou permissão explícita** [S3, S5].

O caminho de menor ambiguidade documental para produto/serviço terceiro é API key ou provider suportado, conforme a orientação oficial [S1, S4]. Para uso próprio pelo assinante através do Claude Code inalterado existe uma hipótese mais favorável, mas **não está demonstrado que o arranjo concreto da Factory, seus usuários e sua carga se enquadrem nela**. Antes de adoção por assinatura, confirmar esse enquadramento com a Anthropic, especialmente se houver serviço a terceiros, múltiplos usuários ou infraestrutura hospedada.

## O que as fontes efetivamente dizem

- **Legal/compliance [S1]:** limites anunciados pressupõem “ordinary, individual usage of Claude Code and the Agent SDK”. OAuth destina-se aos compradores dos planos e ao uso ordinário dos aplicativos nativos. Desenvolvedores de produtos/serviços devem usar API key ou provider suportado; não podem oferecer login Claude.ai em seus aplicativos, rotear solicitações com credenciais de planos em nome de usuários, nem coletar, armazenar ou intermediar credenciais/tokens Claude.ai. O login deve ocorrer pelo fluxo da Anthropic.
- **Exceção delimitada na mesma página [S1]:** não impede o usuário final de autenticar sua própria assinatura no **binário Claude Code inalterado**, inclusive hospedado por plataforma. Preinstalar/executar Claude Code em produtos/serviços exige, salvo acordo diferente, Commercial Terms e condições: não modificar o binário nem remover/desabilitar/restringir métodos nativos de autenticação; cada usuário autentica com sua própria credencial, sem a plataforma pagar, revender ou intermediar o uso. Não é licença para embutir OAuth num harness distinto.
- **Help Center [S2]:** atualização de **15/06/2026** pausa as mudanças anteriormente anunciadas: “For now, nothing has changed”, incluindo SDK, `claude -p` e uso em apps terceiros nos limites da assinatura. Atualização de **07/10/2026** confirma: “when you’re signed in with your Claude plan, the Claude Agent SDK and claude -p still draw from your subscription limits”. É descrição vigente de consumo, não revogação das restrições de [S1, S4], nem garantia permanente.
- **Créditos mensais [S2, S6]:** Max, Ultra e Team incluem créditos API mensais para uso com API key da organização Console vinculada. [S6] informa US$ 100/mês para Max e Pro não elegível. Não confundir esses créditos com limites da assinatura: elegibilidade, vínculo, ativação e condições da conta precisam ser verificados; não há promessa de cobrir a carga da Factory ou impedir cobrança adicional.
- **Headless [S3]:** `-p`/`--print` é execução não interativa, com saída JSON/stream-json e retomada de sessão. **`--bare` não lê credenciais OAuth nem keychain e não usa login de assinatura**; requer API key/helper ou credenciais de provider. Portanto `--bare` não resolve isolamento do perfil para a hipótese de assinatura.
- **Agent SDK [S4]:** é uma biblioteca que executa o binário Claude Code, com seu harness, ferramentas e loop; a página mantém aviso para terceiros usarem autenticação por API key salvo aprovação prévia. SDK Anthropic e Pi coding-agent SDK não são intercambiáveis.
- **Consumer Terms [S5]:** a restrição de meios automatizados/não humanos tem a ressalva literal “Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it”. Ler junto das permissões e condições específicas, não como proibição absoluta nem permissão irrestrita.

## Matriz de cenários

| Cenário | Leitura documental em 2026-11-14 | Consequência para a Factory |
| --- | --- | --- |
| Pi coding-agent chama Claude diretamente com OAuth de assinatura | Pi não é o binário/harness Claude Code; [S2] não concede autorização genérica para credenciais em outro harness | Não tratar como caminho aprovado; não extrair/injetar tokens no Pi |
| Usuário usa sua assinatura no Claude Code inalterado, inclusive `-p` | Consumo por assinatura confirmado [S2]; condicionado a uso/identidade/termos [S1] | Candidato documental para uso próprio, não aceite da Factory |
| Worker usa Agent SDK autenticado pelo plano do próprio usuário | Consumo confirmado [S2]; aviso sobre produtos terceiros permanece [S4] | Esclarecer enquadramento antes de adotar; não equiparar capacidade a autorização |
| Plataforma hospeda binário inalterado e usuário autentica pelo fluxo nativo | Previsto expressamente, sujeito a Commercial Terms e condições [S1] | Não remover métodos nativos, intermediar credenciais ou subsidiar/revender inferência |
| Serviço compartilha assinatura ou oferece seu próprio login Claude.ai | Conflita com restrições de intermediação [S1, S4] | Não é solução documentalmente autorizada |
| Claude CLI/SDK com API key ou provider | Caminho recomendado para produtos terceiros [S1, S4] | Continua exigindo validação técnica e de custos; créditos não são assinatura ilimitada |
| `claude --bare -p` com assinatura | Sem leitura de OAuth/login de assinatura [S3] | Inviável como atalho para assinatura + perfil limpo |

## Encaixe hipotético sem redesenhar o controlador

A [decisão 06](../issues/06-agent-runtime-choice.md#answer) escolheu **Pi coding-agent via SDK** para Builder, Standards e Spec. **Pi Durable + SQLite controla o Trabalho, sem precisar fazer inferência**; não é o harness de coding. Trocar a autenticação/provider do worker Pi não o transforma em Claude Code. A hipótese seria um **adapter de worker Claude CLI/Agent SDK**, mantendo o controlador como autoridade de fila, autorização, perguntas, evidências e ciclo de vida. É substituição explícita da integração de worker, não simples configuração já aprovada.

Preservar as interfaces de Workers/Protocolo não prova que a adaptação seja pequena. Sessões Claude não são checkpoints Pi Durable nem sessões Pi coding-agent; não presumir conversão de histórico. Registrar runtime/perfil/modelo/sessão por Execução e bloquear retomada incompatível, ou recuperar contexto em sessão substituta com razão registrada, conforme a spec.

A [spec, §§7.3 e 7.5](../spec.md#73-processos-filesystem-e-git) mantém workers Pi confiáveis no host, ferramentas do Builder encaminhadas ao guest Gondolin, e revisores restritos ao `read` Pi com backend confinado. **Executar Bash/Edit nativos do Claude no host seria regressão grave**, não implementação equivalente. Rodar Claude dentro do guest ou substituir/desabilitar ferramentas nativas em favor de ferramentas/MCP confinados são apenas hipóteses: precisam demonstrar confinamento, credenciais, persistência, rede e compatibilidade com o binário inalterado, sem novos poderes implícitos.

## Impactos e provas futuras necessárias

1. **ask user:** mapear pergunta para entrega durável ao controlador, encerrar atividade e liberar Slot somente após cessação confirmada. Não deixar ferramenta/Promise aguardando humano ou depender de stdin/UI. A resposta deve iniciar nova Execução admitida; testar crash antes/depois do ACK e retomada sem repetir efeito ambíguo.
2. **Review:** preservar handoff ao controlador, Standards/Spec paralelos na mesma VM/workspace e Builder sem executar durante revisão. Não substituir pelos subagentes nativos Claude silenciosamente. Testar resultados separados, falha parcial, contexto integral com arquivos novos/não commitados e devolução à sessão Builder.
3. **Read-only:** `--allowedTools` documenta autoaprovação [S3], não prova que ferramentas ausentes estejam fisicamente inacessíveis. Validar lista efetiva, negação de shell/escrita/rede e ausência de defaults/fallback host. Reviewer Claude não dispõe automaticamente do contrato exato do `read` Pi; equivalência exige decisão e evidência.
4. **Cessação:** [S3] documenta trabalho em background, retomadas de turnos e até saída 0 antes de comando de subagente terminar; tarefas MCP remotas podem continuar. SIGTERM tem semântica própria (143, turno incompleto, encerramento de árvore Bash, hooks SessionEnd). Não usar exit code, fim de turno ou `interrupt()` como prova universal de cessação. Testar processos descendentes, hooks, MCP, crash, cancelamento e recuperação antes de liberar Slot.
5. **Perfil independente:** a fábrica não pode herdar home, skills, plugins, hooks, MCP, sessões ou credenciais pessoais do operador. [S3] alerta que `-p` sem bare carrega configurações do projeto/home sem diálogo de confiança. [S7] documenta `CLAUDE_CONFIG_DIR` para separar settings/history/login: candidato a perfil dedicado, não sandbox nem solução completa. Usar somente gerenciamento/fluxo nativo de credenciais; não extrair/copiar tokens. Verificar o que ainda é descoberto no repo e como fornecer instruções/skills explícitas com versões fixadas.
6. **Autenticação e quotas:** [S7] alerta que `-p` sempre prioriza `ANTHROPIC_API_KEY` quando presente: risco de cobrança API em vez de assinatura. Validar ambiente resolvido sem expor segredo. Não partilhar conta para multiplicar capacidade, contornar limites ou assumir quotas por Slot; Builder e revisores concorrem pelo orçamento aplicável. Medir bloqueios, reset, concorrência e uso real; custo estimado na saída não mede saldo de assinatura. Falta de quota deve ser visível e não acionar fallback pago silencioso.
7. **Experimento somente após autorização:** fixar binário/SDK/Node e perfil; confirmar enquadramento comercial; depois provar fluxo completo com fixtures e ambiente dedicado, incluindo isolamento de ferramentas, perguntas, duas revisões, cessação e recuperação. Nenhum teste com modelo/login/credenciais foi realizado nesta pesquisa.

## Fontes e limites

Texto efetivo consultado, não snippets de busca. Páginas são mutáveis; a data acima é a consulta, não promessa de validade futura. Leitura documental não substitui contrato aplicável, confirmação da Anthropic nem aceite técnico. A migração do PKM foi lida: versões/caminhos históricos não são instruções para editar o checkout de origem. Nenhuma implementação paralela foi alterada ou validada.

- **[S1]** Anthropic, [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), texto oficial [Markdown](https://code.claude.com/docs/en/legal-and-compliance.md), seções “Can customers offer Claude Code in their products?”, “Acceptable use” e “Authentication and credential use”.
- **[S2]** Claude Help Center, [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), atualizações de 15/06 e 07/10/2026.
- **[S3]** Anthropic, [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), texto oficial [Markdown](https://code.claude.com/docs/en/headless.md), especialmente bare mode, background tasks, SIGTERM e saída estruturada.
- **[S4]** Anthropic, [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), definição da biblioteca e aviso de autenticação para terceiros.
- **[S5]** Anthropic, [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms), restrição de acesso automatizado com ressalvas expressas.
- **[S6]** Claude Help Center, [Monthly API credits for Max, Ultra, and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans), elegibilidade e distinção assinatura/API.
- **[S7]** Anthropic, [Authentication](https://code.claude.com/docs/en/authentication), informações corroboradas pelo supervisor nesta pesquisa sobre `CLAUDE_CONFIG_DIR` e precedência de API key em `-p`.
