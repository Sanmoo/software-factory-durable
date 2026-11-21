# Definir as condições de admissão diante de bloqueadores e leituras incompletas

Status: resolved
Assignee: Samuel Santos
Type: grilling
Label: wayfinder:grilling
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: 01, 03

## Question

Que fatos e pré-condições verificáveis liberam um Trabalho Jira, quando verificar novamente e o que o operador vê se a fábrica não consegue concluir? Cobrir estado configurável, bloqueador aberto, inacessível ou fora do escopo, permissões alteradas, consulta parcial e falha transitória. Se a API não permitir a garantia exigida, delimitar um perfil verificável ou registrar a impossibilidade; nunca substituir evidência por uma lista vazia.

## Answer

**A garantia desta versão vale para os bloqueadores visíveis à conta da fábrica.** Uma leitura válida sem bloqueadores visíveis satisfaz esse critério de admissão. O operador aceita o risco de iniciar um Trabalho cujo bloqueador o Jira omitiu silenciosamente; não se exige prova independente de visibilidade global. A [pesquisa sobre visibilidade](01-visibilidade-jira.md) explica por que não se pode prometer mais.

**Relação e estado.** Usar o tipo padrão `Blocks` do [catálogo do site](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-link-types/), sem configuração obrigatória. Se A *is blocked by* B, verificar B; se A *blocks* B, o vínculo não impede A. Como o Jira [permite alterar os tipos e seus sentidos](https://support.atlassian.com/jira-cloud-administration/docs/configure-issue-linking/), pedir ao operador que indique o tipo e o sentido quando não for possível reconhecê-los sem ambiguidade; até lá, não iniciar. Cada bloqueador visível precisa estar na **categoria de status `Done`**: não se exige uma lista de nomes de status por projeto. A regra vale mesmo se B estiver em outro projeto, sem etiqueta ou sem rota da fábrica. Merge de PR não substitui a leitura do estado de B.

**Momento e diagnóstico.** Imediatamente antes de criar o Trabalho, revalidar os bloqueadores junto com [a intenção e a rota](03-roteamento.md); uma decisão da descoberta não basta.

| Observação nessa tentativa | Resultado |
| --- | --- |
| Leitura válida sem bloqueador visível, ou todos os visíveis em `Done` | Critério de bloqueadores satisfeito; iniciar somente se intenção e destino também estiverem confirmados. |
| Bloqueador visível em categoria diferente de `Done` | **Bloqueado**: não iniciar. |
| Vínculo visível, mas sem estado verificável (por exemplo, `403` ou `404` ao ler B); campo necessário ausente, leitura parcial, timeout ou outra falha detectada | **Não foi possível verificar**: não iniciar nesta tentativa. Reavaliar com nova leitura, sem reutilizar liberação anterior. |

Os dois impedimentos são diagnósticos da fábrica, não mudanças de status no Jira. Dizer o motivo e a ação possível (aguardar a conclusão, conferir acesso/configuração ou tentar novamente). Seguir a regra de publicação segura do roteamento: não repetir o mesmo aviso, não revelar dados restritos de outro projeto e, quando não for seguro comentar, informar o operador fora do Jira.
