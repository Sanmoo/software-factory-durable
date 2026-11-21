# Investigar o que o Jira Cloud permite afirmar sobre Tickets e bloqueadores

Status: resolved
Type: research
Label: wayfinder:research
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: —

## Question

Quais fatos a API pública do Jira Cloud fornece sobre identidade durável (inclusive após mudança de chave ou projeto), descoberta de candidatos, estados e direção/tipo dos links de bloqueio? Distinguir paginação completa de visibilidade completa: comparar um Ticket sem bloqueador com um Ticket cujo bloqueador existe mas está oculto por permissões. Há evidência observável que os distingue? Quais pré-condições, limites e lacunas restam? Citar documentação primária Atlassian por afirmação, data, versão e exemplo de observação; não inferir ausência de um link omitido nem escolher a política de admissão.

## Answer

**A API REST v3 não oferece, nas leituras examinadas, um sinal garantido que distinga “sem bloqueador” de “com bloqueador oculto”.** A última página da busca JQL encerra a consulta para aquele leitor. Se o Ticket não mostrar bloqueadores, não há contador obrigatório de links ocultos; mesmo a consulta direta por ID de link pode devolver `404` tanto por inexistência quanto por falta de acesso a uma das pontas.

No mesmo site, o ID retornado permite correlacionar leituras apesar da mudança de chave; não há garantia aqui para migrações entre sites. Para um link visível, interpretar o tipo e a ponta conforme o catálogo daquele site e distinguir o estado observado do vizinho da própria existência da relação. Por exemplo: no Ticket A, se a descrição `inward` do tipo é “é bloqueado por” e `inwardIssue` aponta para B, B bloqueia A — não o contrário.

O [relatório com contratos, exemplos sintéticos e fontes Atlassian](https://github.com/Sanmoo/software-factory-durable/blob/4cda0b8942dac347814d9ce0f2e93ccb3b1fa64c/.scratch/software-factory-jira/research/visibilidade-jira.md) registra a pesquisa documental de 21/11/2026 na branch `research/jira-visibilidade`, sem acesso a tenant. Determinar se há evidência independente suficiente para liberar um Trabalho cabe a [Definir as condições de admissão diante de bloqueadores e leituras incompletas](04-admissao.md).
