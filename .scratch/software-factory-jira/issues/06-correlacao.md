# Definir o vínculo durável entre Ticket Jira, Trabalho e pull request

Status: resolved
Assignee: Samuel Santos
Type: grilling
Label: wayfinder:grilling
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: 01, 02, 03

## Question

Como localizar e verificar o PR do próprio Trabalho sem timeline de issue GitHub, closing keyword nem issue espelho? Distinguir identidade persistida de chave exibida; decidir como agir com chave alterada, PR concorrente, vínculo ambíguo e merge ocorrido durante indisponibilidade do Jira. Que vínculo e resultado ficam no Ticket e como reconciliá-los sem anunciar entrega prematura ou duplicada?

## Answer

**Identidade do Ticket.** O Trabalho guarda o ID do site Jira e o ID da issue. A chave serve para exibição: se `PAG-42` passar a `FIN-18` no mesmo site, atualizar a chave exibida, sem criar outro Trabalho nem mudar o repositório autorizado. Se o Ticket não puder ser lido pelo ID, informar o operador; não procurar substituto pela chave antiga.

**Reconhecimento do PR próprio.** Se a resposta à abertura do PR se perder, procurar no repositório autorizado o PR que corresponde à branch e à base esperadas, à autoria da fábrica no GitHub e ao marcador daquela publicação. Uma leitura completa com um único PR próprio verificável permite guardar sua identidade no repositório e relê-lo diretamente daí em diante. A menção a `PAG-42` em outro PR não comprova vínculo: não adotar o PR humano nem contar seu merge como entrega. Não depender de timeline de GitHub Issue, closing keyword ou issue espelho. Se a leitura for incompleta ou o vínculo ficar ambíguo, sinalizar o impedimento; não escolher o PR mais recente, abrir outro ou anunciar entrega.

**Um link por Trabalho no Card.** Assim que o PR próprio for confirmado, mesmo em rascunho, publicar um *remote link* com URL do PR e título como **Trabalho T-17 · Abrir PR**. Usar o mesmo `globalId` desse Trabalho nas atualizações, inclusive após timeout ou reinício. Se fechar sem merge, manter o link como **Trabalho T-17 · PR fechado sem merge**; se o GitHub confirmar o merge, atualizar para **Trabalho T-17 · Entregue**. A conta precisa de permissão para manter links, além de comentar. O link informa a equipe; sua presença ou seu título não provam o merge.

**Entrega e aviso são fatos distintos.** O merge confirmado no GitHub do PR próprio torna o Trabalho **Entregue**, mesmo com o Jira indisponível. Guardar o fato e o que falta comunicar. Quando o Jira voltar, reconciliar o link e o aviso pendentes no Ticket original, sem reabrir o Trabalho nem alterar o status ou a resolução do Card.

Além do link, publicar um comentário só após confirmar o merge. Exemplo: **[Software Factory · Entrega T-17] O PR foi integrado a `main`: ‹URL do PR›.** Antes do envio, guardar a referência de entrega e o conteúdo. Se a resposta se perder, aplicar a [regra da conversa no Ticket](05-conversa.md#answer): conferir conta autora, referência e conteúdo nos comentários visíveis. Uma correspondência inequívoca confirma o aviso. Se a leitura completa não o encontrar, pode reenviar com a mesma referência; isso admite duplicação visual, não uma segunda entrega. Leitura incompleta, falha de permissão ou correspondência ambígua deixam o aviso pendente, com diagnóstico ao operador, sem reenvio às cegas. A garantia de atualização por `globalId` vale para o link, não para o comentário.
