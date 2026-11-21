# Investigar identidades, permissões e comentários no Jira Cloud

Status: resolved
Assignee: Samuel Santos
Type: research
Label: wayfinder:research
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: —

## Question

Quais mecanismos documentados de autenticação, escopo e atribuição permitem à instalação ler comentários, distinguir a fábrica de um humano autorizado e publicar e reencontrar uma pergunta, resposta, vínculo ou resultado? Investigar identidade do autor, formato de conteúdo, visibilidade restrita, edições, paginação, rate limits e o caso em que o POST pode ter sido aplicado mas não houve resposta. Distinguir idempotência garantida de mera busca posterior. Comparar as opções compatíveis com uma instalação operada pela equipe. Citar fontes primárias Atlassian, data, versão, permissões e lacunas; não escolher credenciais nem usar um tenant real.

## Answer

O comentário da REST v3 identifica a conta que o criou (`author.accountId`) e a conta da última edição (`updateAuthor.accountId`), não quem estava ao teclado. Se a fábrica usar a conta de uma pessoa, uma publicação automática e uma resposta manual podem ter a mesma autoria. Mesmo com uma identidade técnica separada, a permissão Jira para comentar não autoriza, por si só, a comandar o Trabalho. Se B reescreve como comando um comentário criado por A, não se pode atribuir o novo texto a A.

A leitura mostra o conteúdo ADF **atual e visível**. Paginar por criação não recupera todas as edições; reler pelo ID não recupera todas as versões. Se o Jira aplicar um POST e a resposta se perder, conferir conta, marcador e conteúdo pode reencontrar uma pergunta ou resultado. O contrato de criação de comentários não documenta uma chave de idempotência: não encontrar o marcador **não torna seguro repetir o POST**. Para o vínculo com um PR, o recurso separado de *remote links* documenta criação ou atualização por `globalId`; essa garantia não se estende ao comentário de entrega.

O [relatório com fontes primárias, escopos, exemplos e limites](https://github.com/Sanmoo/software-factory-durable/blob/2a6233d0dde975b3a0646348e4ea601cc6d700e4/.scratch/software-factory-jira/research/interacao-jira.md), na branch `research/jira-interacao`, compara tokens, OAuth delegado, conta de serviço e Forge e distingue restrições de grupo/papel de notas internas do Jira Service Management. Consulta documental em 21/11/2026, sem credenciais ou tenant. As escolhas de instalação, audiência e tratamento de comandos cabem a [Definir quem pode conduzir o Trabalho pelo Ticket Jira](05-conversa.md); o mecanismo de vínculo cabe a [Definir o vínculo durável entre Ticket Jira, Trabalho e pull request](06-correlacao.md).
