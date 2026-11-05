# Migração do planejamento da Software Factory

## Autoridade e origem

O operador autorizou criar `Sanmoo/software-factory-durable` como repositório privado e transferir o esforço aprovado,
com commits/pushes nos dois repositórios e o mesmo tracker Markdown local. Este repositório passa a ser o local canônico desse esforço.

Snapshot principal de origem: [Sanmoo/pkm em 1da4f5fac781bfdbd0b761ea9731e248429a55eb](https://github.com/Sanmoo/pkm/tree/1da4f5fac781bfdbd0b761ea9731e248429a55eb).
O [manifesto verificável](software-factory-from-pkm.json) registra repositório, commit, path, blob Git e SHA-256 original de cada arquivo,
além do path/hash importado e das transformações editoriais. Os sete relatórios usam seus commits individuais publicados, não o snapshot principal.
O manifesto descreve a importação inicial; alterações futuras legítimas devem ter sua própria justificativa e histórico Git.

## Conteúdo transferido

- 26 tickets, preservando títulos, numeração, estados, labels, dependências, perguntas, comentários e Answers.
- Mapa de decisões encerrado e spec técnica aprovada.
- Quatro assets: comparação de durabilidade, revisão cruzada, interfaces/composição e matriz de aceite.
- PRD, de `tecnologia/software-factory-0.0.1-prd.md` para `.scratch/software-factory/prd.md`.
- Sete relatórios de pesquisa, extraídos dos blobs indicados nas resoluções, em `.scratch/software-factory/research/`.
- Regras de tracker e triagem em `docs/agents/`, copiadas sem alteração de conteúdo.

São 40 documentos do esforço e dois documentos de regras compartilhadas. Não foram criados GitHub Issues, tickets de implementação,
código da Factory, credenciais, ambientes ou provas de funcionamento.

## Preservação e ajustes editoriais

As mudanças nos documentos importados limitam-se às transformações registradas no manifesto:
links locais para o PRD, referências externas ao esforço convertidas em citações imutáveis do PKM,
um ponteiro local de relatório nos sete tickets de pesquisa, uma nota de localização atual no mapa
  e a separação de duas citações contíguas `[R][B]` em `[R] [B]`, que eram interpretadas como referências Markdown sem definição.
As decisões, perguntas, comentários, Answers, estados e relações de bloqueio continuam semanticamente iguais.
As referências remotas originais por SHA permanecem preservadas; a cópia local facilita consulta sem depender do checkout do PKM.

Commits sem repositório explícito, branches, nomes de sessões, caminhos absolutos e destinos de integração citados nos registros anteriores
pertencem ao PKM e ao momento em que foram escritos. São proveniência histórica, não instruções para editar aquele checkout
ou reabrir o mapa já encerrado. O histórico Git completo do PKM não foi importado; permanece no repositório de origem.
As branches de pesquisa de origem continuam preservadas, sem merge, PR ou remoção por esta migração.

Experimentos de `agent-orchestration`, `agentic-factory-options`, outros mapas e backlogs antigos permanecem no PKM.
Os links necessários a esses materiais apontam para seus snapshots de origem; não os tornam decisões deste MVP.
No PKM, os originais canônicos só são substituídos por apontadores após confirmar a publicação deste pacote no destino.

## Verificação da importação

Verificar os 42 registros do manifesto: hash original contra o blob de origem e hash importado contra o arquivo de destino;
reconstituir as transformações permitidas e comparar o conteúdo completo. Conferir os 26 tickets e o mapa resolvidos,
Answers, títulos, tipos/labels, responsáveis, dependências acíclicas e índice de decisões.
Conferir links/âncoras locais, sete relatórios presentes, cobertura RF-01–14/RNF-01–05/CA-01–12,
referências aos 17 cenários do plano e contratos públicos/matriz de dependências aprovados.

### Resultado da verificação inicial

- 42 arquivos reconstruídos integralmente a partir dos blobs de origem e das transformações declaradas; hashes originais/importados conferidos.
- 45 documentos Markdown e 599 links/âncoras locais verificados, sem saída do repositório ou dependência de outro checkout.
- 26 tickets resolvidos, títulos/identificadores/campos preservados, Answers presentes, índice completo e dependências acíclicas.
- Sete relatórios presentes; branches remotas de evidência conferidas nos sete SHAs preservados no PKM.
- Cobertura de 14 RF, 5 RNF, 12 CA, 17 cenários e 40 assinaturas públicas preservada; regras de tracker/triagem byte a byte idênticas.
- Probe LSP ativo nos 46 arquivos Markdown/JSON; dois avisos herdados de citações contíguas foram corrigidos editorialmente e rechecados.
  Os arquivos afetados passaram sem erros/warnings após a correção; nenhum linter Markdown adicional ou pacote foi instalado.

A validação é documental: preserva a aprovação existente e não demonstra funcionamento, isolamento, capacidade ou aceite do MVP.
