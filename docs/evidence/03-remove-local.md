# 03 — remoção local autorizada, conservadora e repetível

Continuação após ff40e66. Imagem4b6/V3 e todos os recursos históricos intocados.
Nenhuma VM, sinalização, mount, cleanup de u3/v3/UNKNOWN ou exclusão de worktree.
Somente fixtures novas próprias são removidas pelos testes.

## Contrato e fronteira

Implementado remove({environment,cleanup}) na interface Q5 existente. Cleanup
vincula workId, workDisposition delivered/cancelled, confirmedtrue e
evidencePreservedtrue. São **assertivas do Controle host confiável**, não bearer
tokens/argumentos de modelo nem segundo sistema de autorização de Trabalho.
Controle precisa confirmar seleção/perdas, encerrar Trabalho e preservar conteúdo
necessário FORA da área removível antes da chamada. Remove não cancela Trabalho,
consulta GitHub, apaga PR/branch ou exclui histórico. Não projetar método ao worker.

Propriedade/ready/workhash validados; lifecycle-lock compartilhado com start;
current e inventário completo de boot-* reconhecíveis; observação de cessação
própria de TODOS os boots antes da intenção, de cada efeito e da conclusão.
Ausência de metadata/current não vira cessação: ambiente sem evidência suficiente
continua indeterminado, inclusive o recorte preparado-sem-boot ainda não provado.

Intenção de cleanup persistida com barreira fresca antes de unlink. Fences em
prepare/start impedem recriação/retomada com cleanup pendente, mesmo intenção
incompleta. Só disk/workspace/artifacts e runtimes derivados do boot são alvos.
Roots symlink, UID/mode incerto, hardlink regular compartilhado, outros devices e
mounts/bind aliases no alvo/subárvore são recusados. Symlink descendente é apagado
como link, nunca percorrido. Per-resource removed/absent/refused/failed; ausência
só por ENOENT da entrada própria e sync do pai, não falha de consulta genérica.

Owner/ready/current/boot metadata, evidências de filesystem e Records externos
permanecem. Marcador removed privado não basta para observe: request/current/
inventário precisam coincidir, todos os boots continuam confirmadamente cessados
e TODOS os alvos precisam estar ausentes. Caso contrário indeterminado. Consumo
segue unavailable, nunca zero presumido.

## RED/GREEN e revisão

Seam: chamadas públicas createSandbox/remove/observe/start/prepare. Manager externo
com PATH sem fallback e arquivos reais, nenhum serviço/VM. RED inicial operação
inexistente; GREEN recusa de autorização. RED remoção positiva; GREEN efeitos reais
somente nos fixtures. RED observe-stopped vs removed e runtime com owner ausente
falsamente tratado como ausente; corrigidos. RED fence; corrigido.

Revisão independente única ab431421 confirmou guards e achou dois P1:

1. rm recursivo pode apagar runtime/owner.json antes de falhar. Correção direta:
   identidade validada (env/boot/dev/ino/UID/birthtimeNs) guardada DURAVELMENTE fora
   da subárvore. Retry sem owner interno exige essa identidade exata; diretório
   recriado/ownerless ou evidencia inválida continua recusado. Falta de birthtime
   utilizável não é autorização presumida.
2. Escrever removed.json diretamente pode publicar prefixo malformado. Correção:
   publicação exclusiva atômica de JSON completo/fsynced em nome privado, link
   exclusivo para final, remoção do link temporário e sync do pai. Janela de
   interrupção entre link/unlink é recuperável SOMENTE por par privado de mesmo
   inode/conteúdo esperado; não aceitar hardlinks arbitrários. Prefixos incompletos
   ficam em nomes temporários preservados, não no nome final. Genuíno final
   malformado preexistente não é sobrescrito. Aplicado também a intenção e ledger.

Ambos tiveram regressões RED2 -> GREEN2; mais caso de interrupção após link e de
final malformado. Não aberta cadeia de revisão. Testes usam falhas nas fronteiras
FS (FileHandle e rm/unlink), nunca substituem módulos do produto.

22 casos focados passam: autorização/Work incorretos, ativo/incerto/boot desconhecido,
histórico preservado, retry parcial/idempotência, aliases, hardlinks, falha de sync
file/dir, perda da evidência de cessação entre efeitos, recuperação dos dois P1,
publicação interrompida após link e falsificação/reaparecimento após removed.

## Limites de aceite

Dublê de manager não prova cessação física ou cleanup real de VM. Nenhum histórico
foi limpo; V3 continua qualificado apenas no subconjunto já registrado. Mount alias
é verificado por fonte, sem criação de mounts neste teste. Não há contenção contra
comprometimento da conta/processos host confiáveis. Lifecycle-lock ainda conserva
recusa se fica pendente após perda do processo; não inventar recuperação de lock
por PID ausente. Este incremento não certifica crash recovery global do Controle.

Faltam confinamento/aliases RealFS, isolamento entre ambientes e owner-loss reais,
mais demais critérios03; nenhum checkbox completo promovido por estes testes.
Gates finais:100casos99pass/1VMskip/0fail (~20.80s), strict compile/build,
arquitetura/ESLint71módulos318dependências e diff-check. LSP consultado sem usar
silêncio push-only como certificado; compilação estrita confirma os tipos.
Commit no histórico da branch; integração b591ec7 permanece intacta.
