# Software Factory MVP v2: o caminho de um ticket até o merge

A Software Factory cuida do intervalo entre duas decisões humanas: **“este ticket pode ser implementado”** e **“esta mudança pode entrar na base”**. Nesse intervalo, ela coordena um agente que escreve código, dois que o revisam e as esperas por respostas e pelo CI. O resultado esperado é um pull request (PR) revisável. Quando isso não é possível, o resultado útil é um bloqueio que diga ao operador o que aconteceu e qual decisão falta.

A novidade da v2 não é outro agente. É a possibilidade de executar as ferramentas do agente em uma máquina temporária na conta AWS do operador. A máquina pode desaparecer; a Factory precisa continuar sabendo **qual era o trabalho, onde está o código e o que ainda não foi confirmado**. A história a seguir ilustra o comportamento especificado, não relata uma execução já homologada.

## Um ticket, duas máquinas, um só Trabalho

1. **Autorizar.** Imagine a issue “Rejeitar pedidos sem endereço de entrega”. O operador aplica `ready-for-agent` (label padrão) em um repositório autorizado. A Factory consulta o GitHub periodicamente, verifica se a issue está aberta e se suas dependências estão satisfeitas. Registra um **Trabalho**: a identidade persistente daquele ciclo de entrega. Ler a mesma issue amanhã não cria um segundo Trabalho.
2. **Começar.** Quando há um **Slot** (vaga para um Builder ativo), começa uma **Execução**. O **Builder**, agente responsável pela mudança, recebe o ticket, a base e as instruções do repositório. No perfil Lambda, a Factory inicia uma MicroVM e prepara nela um checkout da branch do Trabalho. Chamamos de **boot** a vida dessa máquina, não a vida do Trabalho.
3. **Perguntar sem perder código.** O Builder escreveu um teste e descobriu uma ambiguidade: “A regra também vale para retirada na loja?”. Abre uma **Pergunta** identificada para o operador. Antes de deixar a máquina, publica na sua branch o trabalho parcial que pode ser compartilhado com segurança. O Controlador verifica no ambiente três fatos: não há mudanças pendentes (inclusive arquivos novos não ignorados), não há stash e o `HEAD` é exatamente a ponta consultada no remoto `origin`. Um commit apenas local não basta. Se essa verificação falhar, o Builder recebe o motivo; três recusas seguidas na mesma devolução geram Bloqueio. Não se publicam segredos para satisfazer a verificação.
4. **Esperar e retomar.** Confirmada a preservação, a Factory encerra a MicroVM e só libera o Slot quando o serviço confirma a parada. A pergunta fica registrada e visível na issue ou no PR. O operador responde, por exemplo, `/factory answer Q-17 Não; retirada na loja dispensa endereço`. Uma resposta autorizada e vinculada à pergunta recoloca o Trabalho na fila. Num novo boot, com histórico remoto compatível, a mesma sessão do Builder recebe a resposta, o commit de partida e o aviso de que caches e dados do Docker sumiram. Ela encontra o teste no Git, não no disco antigo.
5. **Revisar e publicar.** O Builder implementa a exceção e roda as validações do projeto. Dois revisores independentes leem a mudança em paralelo: **Spec** verifica se entrega o que o ticket pediu; **Standards**, se segue as convenções do repositório. Nenhum edita o código. O Builder trata os achados e publica o PR como *draft*. O push parcial do passo 3 preservou código; não foi um pedido de revisão humana.
6. **Acompanhar até a decisão humana.** Com revisões concluídas, validações atendidas e sem conflito ou bloqueio conhecido, a Factory sinaliza prontidão. Enquanto espera CI ou decisão humana, não ocupa Slot. Check obrigatório que falha, conflito ou feedback acionável podem gerar um **Reparo** prioritário no mesmo Trabalho. **PR aberto não é Trabalho entregue:** só o merge por uma pessoa, confirmado no GitHub, conta como entrega. A Factory pode então limpar os recursos que reconhece como seus.

## A arquitetura: quem decide, quem executa, o que sobrevive

```text
Operador ── CLI local ou comentário autorizado ──► Controlador local
GitHub   ◄──── issues, dependências, PR, CI ────►  │
                                                  ├─ Pi Durable + SQLite: fila, decisões e esperas
                                                  ├─ Workers Pi: Builder e revisores no host
                                                  └─ Adaptador de sandbox escolhido na instalação
                                                       └─ VM: checkout, ferramentas e Docker
                                                              └─ Builder publica branch/PR no GitHub
```

O **Controlador** é o único dono das decisões operacionais: admitir, despachar, liberar capacidade, bloquear e reconciliar o estado após uma queda. O **harness** é o runtime que conduz a sessão de um agente; a v2 mantém o Pi do MVP. O **sandbox** é outra coisa: é onde as ferramentas leem arquivos, executam comandos e testam a mudança. O host permite ao Builder escrever e publicar, mas aos revisores oferece só leitura. A chave emissora da GitHub App fica no Controlador; no perfil Lambda, as credenciais AWS também ficam fora do ambiente de trabalho.

Há três registros com funções diferentes. **SQLite** conserva a decisão “estamos esperando a resposta Q-17”. **A sessão** conserva o contexto do agente para interpretar a resposta. **A branch remota** conserva o teste que ele escreveu. Nenhum substitui os outros: uma conversa salva não recupera um arquivo sem push nem prova que o GitHub recebeu uma operação.

## O que muda com Lambda — e o que não muda

| Funcionalidade | MVP original (Gondolin) | Perfil Lambda da v2 |
| --- | --- | --- |
| Entrada, revisão e entrega | Issues autorizadas, dependências, fila persistente, limites, reparos, PR draft e merge humano. CLI para inspecionar, pausar ou intervir. | Mesmas regras e mesmos papéis. Muda o local de execução das ferramentas, não quem autoriza a entrega. |
| Ambiente por Trabalho | VM local com disco e workspace preservados entre boots. | MicroVM reconstruída a partir da imagem do ambiente declarado pelo repositório e do Git remoto. Sem restauração de RAM, cache ou volumes Docker. |
| Esperas e limites | Esperas externas não ocupam Slot. | Preservar no remoto e encerrar antes da espera. Perto do limite de duração do boot, uma troca planejada mantém Execução, sessão, Slot e relógio de timeout; dois boots seguidos sem commit novo geram Bloqueio. |
| Operação e diagnóstico | O Controlador registra limites, consumo e efeitos; verifica o estado antes de retomar após crash. | Soma MicroVM-segundos por Trabalho, verifica quotas, identifica recursos por tags e reconcilia máquinas órfãs. Não calcula nem limita a fatura em dólares. |

A escolha é **por instalação**, não por ticket. Se o repositório exige uma capacidade ausente, o resultado é um diagnóstico, não uma troca silenciosa para o outro adaptador. No Lambda as ferramentas chegam ao ambiente por SSH sobre WebSocket; o perfil permite saída à internet mais ampla que no Gondolin. É uma instalação para um operador na própria conta, não um SaaS nem uma promessa de conter código deliberadamente hostil. Trocar Pi por Claude Code, fazer deploy e fazer merge automático não são funcionalidades da v2.

### E se a máquina cair antes do push?

Uma espera planejada termina com código confirmado. Uma morte inesperada, não. Se o ambiente morre, o Controlador encerra a Execução e registra o consumo e a perda desde o último push. Um mecanismo de término pode salvar o último commit numa referência auxiliar; é uma tentativa, não um backup de arquivos sem commit. A **sessão substituta** entra pela fila numa nova Execução, consumindo uma retomada do orçamento. Recebe o último commit confirmado, o que se perdeu e os efeitos incertos registrados, não a conversa antiga. Se uma operação pode já ter acontecido, a substituta faz o que independe dela e pergunta antes de repeti-la.

Já uma conexão interrompida não prova que a máquina morreu. Se o serviço ainda a vê ativa, o adaptador reconecta, encerra o processo órfão e devolve resultado **indeterminado**. Essa distinção impede transformar “não recebi confirmação” em “posso executar de novo”.

## Até onde vai a evidência?

- **Produto especificado:** o [PRD](../.scratch/software-factory/prd.md) define a jornada e os critérios de entrega. A [arquitetura do MVP](../.scratch/software-factory/spec.md) distribui as responsabilidades; a [spec da v2](../.scratch/software-factory-v2/spec.md) altera apenas o contrato do perfil Lambda. No [primeiro piloto do MVP](evidence/35-pilot-report.md), cinco tickets reais foram tentados e nenhum PR foi publicado. Em um deles, código e testes passaram, mas um disco inconsistente impediu o boot de publicação: um exemplo concreto da diferença entre implementar e entregar.
- **Mecanismos observados:** a [prova de infraestrutura](../.scratch/software-factory-v2/research/lambda-proof-results.md) exercitou Docker, transporte e ciclo de vida no perfil testado. A [prova de continuidade](../.scratch/software-factory-v2/research/agent-continuity-results.md) verificou a preservação via Git e expôs dois limites: a morte da máquina não encerrou corretamente a atividade do agente, e a substituta não cumpriu toda a conduta esperada. A [prova do ambiente Alpine](../.scratch/software-factory-v2/research/alpine-guest-results.md) demonstrou o ambiente declarado em ARM64; não demonstrou x86 nem reuso da imagem por chave.
- **Aceite ainda distinto de protótipo:** o [ticket de aceite Lambda](../.scratch/software-factory-v2-lambda/issues/16-v2-acceptance-on-lambda-profile.md) exige repetir a jornada do MVP em repositório real, com modelos reais, e demonstrar as condições da matriz da v2 — inclusive que não há atividade do agente após morte confirmada e que a substituta publica e pergunta diante de um efeito incerto. A aprovação da spec não atesta esses resultados; mesmo após o aceite, homologar para produção é uma decisão separada do operador.
