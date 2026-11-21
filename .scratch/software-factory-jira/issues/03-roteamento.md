# Definir a seleção de Tickets e o roteamento para um repositório

Status: resolved
Assignee: Samuel Santos
Type: grilling
Label: wayfinder:grilling
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: —

## Question

Como o operador declara quais Tickets podem entrar e para qual repositório GitHub autorizado cada um vai? Usar o caso de um projeto PAG atendendo checkout-web e payments-api. Definir o sinal de intenção da equipe, exemplos de correspondência única, ausente e ambígua, quando revalidar e o diagnóstico que permite corrigir a configuração. Não escolher um mecanismo de API por conveniência.

## Answer

A equipe sinaliza que quer atuação da fábrica com uma etiqueta escolhida pelo operador (por exemplo, `factory-ready`), não com o status do Ticket. A etiqueta torna o Ticket **candidato**; não autoriza por si só criar um Trabalho nem dispensa a verificação de bloqueadores. Um Ticket lido sem a etiqueta fica fora da seleção, sem comentário.

O operador configura rotas de **(projeto Jira, componente) para repositório GitHub autorizado**. Com a lista completa de componentes, contam-se destinos distintos, não componentes. No projeto `PAG`, suponha que `Checkout` e `Carrinho` apontem para `checkout-web`, `Pagamentos` para `payments-api` e `UX` não tenha rota:

| Componentes do Ticket marcado | Resultado do roteamento |
| --- | --- |
| `Checkout`; `Checkout` + `UX`; ou `Checkout` + `Carrinho` | Um destino: `checkout-web`. |
| Nenhum, ou apenas `UX` | Nenhum destino. Não iniciar; indicar a ausência de correspondência. |
| `Checkout` + `Pagamentos` | Dois destinos. Não iniciar; indicar as duas rotas, sem escolher por prioridade. |
| Leitura incompleta, mesmo que `Checkout` esteja visível | Destino não verificável. Não iniciar; indicar falha de leitura, não ausência de rota. |

Imediatamente antes de criar o Trabalho, a fábrica relê a etiqueta e os componentes e recalcula o destino com a configuração vigente. Vale o destino único autorizado **nessa revalidação**, não o encontrado na descoberta. Sem intenção confirmada ou sem destino único verificável, não cria o Trabalho. Uma edição posterior do Ticket não redireciona um Trabalho já iniciado.

**Diagnóstico no próprio Ticket.** Com a intenção confirmada, comentar o impedimento e a ação que permite corrigi-lo. Exemplo: “Não iniciei o Trabalho: Checkout aponta para checkout-web e Pagamentos para payments-api. Confira os componentes do Ticket ou peça ao operador para corrigir a tabela de rotas.” Para leitura incompleta, dizer que não foi possível verificar o destino e orientar a conferir acesso ou tentar novamente, não a cadastrar uma rota.

Não repetir o aviso enquanto persistir o mesmo impedimento; comentar novamente se o motivo mudar (por exemplo, de dois destinos para nenhum). Se a publicação não for confirmada, tentar reencontrar o comentário antes de considerar novo envio: não encontrá-lo não prova que o Jira rejeitou o primeiro, conforme [Investigar identidades, permissões e comentários no Jira Cloud](02-interacao-jira.md). Se a etiqueta não puder ser verificada ou não for possível comentar com segurança, não iniciar nem publicar às cegas; tornar o motivo visível ao operador fora do Jira.
