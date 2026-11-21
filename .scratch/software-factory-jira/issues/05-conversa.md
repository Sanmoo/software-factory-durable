# Definir quem pode conduzir o Trabalho pelo Ticket Jira

Status: resolved
Assignee: Samuel Santos
Type: grilling
Label: wayfinder:grilling
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: 02

## Question

Como provisionar e limitar a identidade da fábrica, reconhecer e autorizar pessoas e comandos e reconciliar perguntas e respostas sem duplicar efeitos? Especificar o que é lido, publicado e recuperado após timeout/restart, alteração de permissão ou comentário editado. Dar exemplos observáveis de comando legítimo, não autorizado e ambíguo. À luz de [Investigar identidades, permissões e comentários no Jira Cloud](02-interacao-jira.md#answer), quais separações de conta e garantias de audiência são pré-condições da instalação? Delimitar se a conversa admite solicitações do Jira Service Management (comentário público ou nota interna) ou apenas comentários da Platform, e como agir quando não se puder confirmar a audiência. A escrita no Jira não inclui transições, atribuição ou resolução.

## Answer

**Conta e autoridade.** Configurar a URL do Jira Cloud, o e-mail e o token de API do controlador. A conta pode ser pessoal: não exigir conta exclusiva, cadastro prévio de `accountId` nem chamada prévia de identidade. Manter o token fora do agente e dos comentários. A conta precisa ler Tickets, bloqueadores e comentários e publicar comentários; a fábrica não atribui, transiciona nem resolve o Ticket. Falha de leitura/escrita é informada ao operador, não tratada como sucesso.

Para o Trabalho daquele Card, a permissão do Jira para comentar basta para responder ou comandar (inclusive retomar ou cancelar); não há lista adicional de operadores nem associação com identidades GitHub. Ler o comentário no Ticket de origem, não confiar em autor declarado no texto nem aceitar uma referência a outro Card. Comandos globais, administrativos e destrutivos da instalação continuam locais. Usar comentários comuns da Platform, destinados a quem pode ler o Ticket, sem configuração extra de audiência. Não reproduzir texto restrito para audiência maior. Se não for possível confirmar a audiência, não publicar e informar o motivo localmente. Solicitações do Jira Service Management ficam fora deste recorte.

**Como conversar.** A fábrica abre suas publicações com cabeçalho visível reservado e referência estável, por exemplo `[Software Factory · Pergunta Q-17]`. Nunca interpretar esse comentário como instrução, mesmo se ele contiver um exemplo de comando. O cabeçalho não autentica quem escreveu. Não descartar a conta inteira: a pessoa que emprestou a conta pode escrever um novo comentário humano.

- Sem o prefixo inicial `/factory`, o comentário é conversa entre pessoas. Comandos conhecidos têm precedência e exigem sintaxe exata: `/factory cancel` cancela o Trabalho do Card; `/factory acho melhor cancelar` não executa cancelamento. Não corrigir grafia para executar ordens. Comando conhecido incompleto recebe orientação, não vira resposta.
- Com exatamente uma pergunta aberta naquele Card, **`/factory sim, preserve a API atual`** responde a ela. Sem pergunta aberta, avisar que não há a que responder, sem alterar o Trabalho.
- Com várias abertas, não escolher pela ordem: listar as referências e exemplificar **`/factory q17: sim, preserve a API atual`** para escolher Q-17. A referência explícita só vale para pergunta aberta daquele Card. A forma anterior `/factory answer Q-17 <texto>` também é válida; **`answer` nunca é obrigatório**. Uma resposta aceita volta pelo fluxo normal do Trabalho, sem lançar outra Execução diretamente.

**Edição, reinício e publicação incerta.** Para corrigir uma instrução, escrever outro comentário. Não aceitar comentário já observado como editado; edição posterior não desfaz nem repete o que foi aceito. Persistir a identidade do comentário de origem junto da transição: reler o mesmo comentário após reinício não repete o efeito. Uma pergunta respondida não volta a abrir por causa de outra cópia da publicação.

Antes do POST, guardar a referência lógica e o conteúdo a publicar. Após timeout ou reinício, reconciliar os comentários visíveis do Card por conta autora, referência e conteúdo. Uma correspondência inequívoca confirma o envio; se **a leitura completa não encontrar** o comentário, **pode reenviar com a mesma referência**, aceitando o risco de duplicação visual. Não prometer publicação única. Falha, perda de permissão ou paginação incompleta não são ausência. Se a leitura falhar ou o resultado for ambíguo (por exemplo, duas cópias), sinalizar localmente e não reenviar às cegas. Duas publicações de Q-17 não criam duas perguntas.
