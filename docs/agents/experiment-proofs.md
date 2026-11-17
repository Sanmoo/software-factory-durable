# Guardrails de provas e ensaios de agentes

Usar antes de preparar provas com modelos ou infraestrutura. Este documento governa a mecânica do
ensaio; não altera specs/aceites anteriores nem implementa interfaces da fábrica.

## Antes de consumir orçamento

1. **Rubrica:** vincular cada critério à pergunta da spec, ao recorte local e a uma observação mínima.
   Separar propriedades contratuais de tarefas auxiliares. A revisão confirma a interpretação antes
   do ensaio: por exemplo, não-replay e edição concluída têm critérios diferentes.
2. **Perfil:** registrar SHA da referência, versões efetivas, caminho do executável, modelo resolvido,
   ferramentas ativas e canais habilitados. Um alias não é um modelo resolvido; opção solicitada não
   é inventário efetivo. Fixar a versão sem alterar perfil/atalho pessoal. Confirmar autenticação
   nativa sem extrair tokens e obter autorização separada de recursos, consumo e cleanup.
3. **Preflight:** exercitar recibo → página de leitura, fixture e oráculos positivos/negativos antes
   de inferir. Um scanner precisa confirmar que encontrou a fonte esperada; diretório vazio não
   comprova ausência de vazamento. Resultado deste passo é preparação validada, não aceite do harness.
4. **Retenção:** definir fontes, coleta sanitizada e remoção separadamente. Confirmar que falha de
   avaliação ainda deixa evidência recuperável. Cessação vem antes de admitir substituto; apagar
   fontes diagnósticas vem depois de preservar/verificar os registros.
5. **Integração:** definir de início quais registros vão para main e qual branch conserva o código
   descartável. Validar o diff documental, sem incorporar o protótipo como implementação de produção.

Cada passo termina com uma evidência ou recusa explícita. Hash de rubrica e texto `approvedBy` são
registros de revisão, **não autenticação humana nem autorização de gastar quota**. Um orçamento
encerrado não é reaberto por editar um arquivo ou por um ensaio sintético passar.

## Rubrica por propriedade

Formato e exemplo sintético: [rubrica do runner offline](../../scripts/agent-checks/fixtures/rehearsal-rubric.json).
Cada linha declara `id`, `kind` (`contract` ou `auxiliary`), `requirement`, `witness`, `fixtures` e
`excludes`. O documento também declara `schemaVersion: 1`, `id`, `version` e `scope`.

A aprovação registra o SHA256 **dos bytes do arquivo** e quem revisou. Verificação sem modelos:

```sh
node scripts/agent-checks/check.mjs --docs-only \
  --rubric caminho/da/rubrica.json --approval caminho/da/aprovacao.json
```

Os caminhos são relativos ao repositório, sem traversal ou symlinks externos. O arquivo de aprovação
usa `{ "rubricSha256": "<64 hex>", "approvedBy": "<registro da revisão>" }`.

Alteração de interpretação produz nova versão/rubrica e revisão explícita. Resultados antigos
continuam associados à rubrica original. O reviewer verifica se a observação sustenta a propriedade;
o checker só verifica formato, identidade e consistência. Não exigir produção quando a spec permite
fixture, nem reduzir um requisito por conveniência após observar falha.

## Helper de finalização

Interface: [finalizeProof](../../scripts/agent-checks/finalize.mjs).
Usar em `finally` de composição confiável, com callbacks do próprio ensaio — nunca funções/caminhos
fornecidos pelo modelo. O diretório de saída deve ser novo, persistente, privado, fora da área
escrita pelo executor. Seu pai já deve existir. Exemplo de integração:

```js
const plan = await readApprovedRubric(repoRoot, rubricPath, approvalPath);
const result = await finalizeProof({
  directory: privateEvidenceDirectory,
  criterionIds: plan.rubric.criteria.map(criterion => criterion.id),
  stop: confirmCessationWithoutDeletingSources,
  collect: collectAllObservations,
  sanitize: sanitizeAccordingToTheExperimentPolicy,
  assess: evaluateEachCriterion,
  remove: removeOnlyOwnedDiagnosticSources,
});
```

Sequência observável:

- `stop` sempre é tentado, inclusive se o diretório de saída estiver indisponível. Seu recibo
  `{ceased: true}` é uma afirmação do callback confiável, não confirmação física pelo helper.
- `collect` e `sanitize` precedem `evidence.json`; arquivo e diretório recebem fsync. O snapshot
  sanitizado fica sincronizado antes de chamar `assess`. O limite de serialização é 1 MiB, com JSON
  finito: sem truncar ou converter NaN/undefined silenciosamente em outra observação.
- `assess` recebe dados sanitizados e devolve **exatamente** os IDs declarados, cada um com
  `approved`, `rejected` ou `inconclusive`. Não há um boolean global que misture edição, não-replay,
  infraestrutura e cleanup. Exceções de callbacks recebem códigos por etapa, não texto bruto.
- `assessment.json` e `cleanup-intent.json` precedem `remove`; integridade do snapshot é revalidada.
  Falha da avaliação não impede cleanup se a evidência estiver verificada. Ausência/mudança de
  evidência ou cessação não confirmada bloqueia a remoção das fontes.
- `cleanup.json` registra sucesso/falha da remoção separadamente. Falha de gravação do resultado
  deixa estado `unknown`, não cleanup presumido. Diretórios existentes são recusados, sem reset.

**Limites:** a política `sanitize` é obrigatória e pertence ao ensaio; o helper não é DLP, sandbox,
serviço de orçamento ou garantia de durabilidade contra perda de energia. Nenhuma exceção bruta é
copiada automaticamente para a evidência. Se a coleta falha, as fontes ficam retidas e a composição
precisa reportar o resíduo; se nem o diretório puder ser criado, o retorno em memória informa a falha.
`stop` deve retirar capacidade preservando essas fontes; `remove` nunca deve apagar o diretório de
evidências nem recursos de outras frentes. Callbacks são código confiável e não são confinados pelo
helper. Evidência sanitizada relevante deve ser arquivada/revisionada antes de descartar a worktree.

## Ensaio estrutural sem modelo

Runner: [rehearse.mjs](../../scripts/agent-checks/rehearse.mjs). Ele só conhece o harness falso embutido;
não carrega SDK/provider, credencial, plugin, comando shell ou código a partir de argumentos.

```sh
mkdir -p .agent-check-tmp
node scripts/agent-checks/rehearse.mjs \
  --scenario auxiliary-edit-failure --output .agent-check-tmp/ensaio-novo
```

O diretório final deve não existir. O runner recusa reutilizá-lo, sem apagar o histórico/contador.
O relatório traz `kind: synthetic-structural-rehearsal`, `nativeInferences: 0`, contagem simulada,
rubrica, ordem das etapas e resultados independentes. Exit 0 significa que o cenário foi registrado,
**não que seus critérios passaram nem que um harness real foi aprovado**.

Cenários: `success`, `auxiliary-edit-failure`, `missing-tool`, `missing-capture`, `empty-scan`,
`model-drift`, `budget-exhausted`, `collection-failure`, `sanitization-failure`, `assessment-failure`,
`cleanup-failure`, `cessation-unconfirmed`, `effect-replay` e `activity-after-stop`. Os preflights
negativos impedem ativação até do dublê. Replay e observação de atividade contradizendo um recibo
de cessação rejeitam a propriedade correspondente, sem contaminar os outros critérios.
Os caminhos de falha são exercitados até persistência/remoção, não só como funções isoladas.

`.agent-check-tmp/` é descartável e ignorado pelo Git, apropriado **somente para estes exemplos e
testes sintéticos**. Não usá-lo como única cópia de evidência de uma prova real. A suíte cria/remove
apenas seu diretório temporário próprio no filesystem do repositório, evitando depender da quota
compartilhada de `/tmp`. Resíduos de outras execuções não são removidos automaticamente.

## Checks locais e CI

Comando único, sem instalar dependências:

```sh
node scripts/agent-checks/check.mjs
```

Requer Node 24 e Git. Executa os testes determinísticos e a validação documental; não inicia modelos,
boots, serviços externos nem a suíte nativa do MVP. O CI executa o mesmo comando, com permissões
mínimas e sem persistir credenciais de checkout. O workflow só passa a executar quando publicado;
esta mudança, por si só, não faz push.

A checagem documental cobre `AGENTS.md`, `docs/agents/` e `.scratch/software-factory-v2/`, sobre
arquivos rastreados e arquivos novos não ignorados. Referências migradas do PKM em outras árvores não são julgadas
como caminhos deste checkout. Para execução só documental: `--docs-only`; para outro checkout,
`--root <raiz-git>`. Um subdiretório não é aceito como raiz vazia que passa por engano.

Verifica links Markdown relativos inline/de referência (fora de blocos/trechos de código), arquivos
locais, manifestos `*-documentary-import.json`, JSON válido e hashes dos registros brutos. Não faz
fetch de links externos nem valida genericamente anchors de headings. Arquivos de protótipo na
árvore documental v2 e arquivos `.runtime/` não ignorados são recusados; código experimental deve
continuar em branch própria. Os checks de implementação do MVP são outra responsabilidade.

O [manifesto da prova de harness](../../.scratch/software-factory-v2/research/harness-proof-documentary-import.json)
registra também SHA de Markdown no momento da importação. Esse SHA é proveniência histórica, não
um lock perpétuo no mapa ou ticket. Os **JSONs de evidência** permanecem byte-idênticos ao hash
registrado; mapas/relatórios podem evoluir por edição revisada, mantendo seus links e histórico.
O checker funciona em clones sem os commits/branches locais inéditos do experimento: ele verifica
os hashes registrados, não finge buscar ou revalidar a fonte primária ausente.

## Economia de contexto

Consultar fontes grandes por metadados/IDs e trechos relevantes. Projetar JSONs localmente para
retornar campos necessários; uma saída truncada não serve de entrada completa a um parser.
Scanner/collector deve registrar quais fontes encontrou e falhar quando a fonte esperada falta,
em vez de transformar ausência de dados em aprovação. Isso mantém diagnóstico sem despejar logs
brutos ou usar atenção/contexto como substituto da evidência persistida.
