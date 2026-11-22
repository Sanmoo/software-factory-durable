# Triage labels

O estado de triagem é uma label da issue no GitHub. Cada issue aberta tem no máximo uma delas.

| Papel | Label | Significado |
| --- | --- | --- |
| needs-triage | `needs-triage` | Precisa de avaliação |
| needs-info | `needs-info` | Precisa de esclarecimentos |
| ready-for-agent | `ready-for-agent` | Especificado para implementação por agente |
| ready-for-human | `ready-for-human` | Requer implementação humana |
| wontfix | `wontfix` | Não será implementado |

Quando uma skill pedir uma label de triagem, usar a label correspondente desta tabela.

`ready-for-agent` tem o mesmo nome da etiqueta de admissão padrão da Factory (`repositories[].label`).
Enquanto a Factory não estiver configurada para este repositório, a label não autoriza a entrada de nada.

Estados que antes ficavam na linha `Status:` do tracker local: `claimed` virou assignee, e `resolved`
virou issue fechada. `bug` e `enhancement` continuam disponíveis como categoria, fora da triagem.
