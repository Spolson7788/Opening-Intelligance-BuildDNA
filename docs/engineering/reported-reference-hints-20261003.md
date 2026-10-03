# Reported markings and reference lookup

Technician markings such as `Cal_Royal 441` previously participated only in a
free-text query containing unrelated form defaults. The catalog uses `CR441`,
so the query could return no reference even after the manufacturer source was
imported.

The reference service now recognizes bounded Cal-Royal CR441/441 and LCN
4040XP/4041 DA markings as brand-scoped lookup hints when no explicit model or
series exists. An unsupported explicit model never falls back to these hints.
Reported hints do not modify photographed identity, confidence, or purchasing
approval. Existing photo evidence requirements for LCN look-alikes remain.

Validation covers the original markings and unrelated defaults, exact model
boundaries, missing/wrong brands, LCN spellings, unsupported explicit models,
and preservation of the photographed identity. Native PostgreSQL reference
acceptance continues to verify draft exclusion and citation validation.
