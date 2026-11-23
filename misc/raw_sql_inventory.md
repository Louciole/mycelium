# SQL brut dans le backend Mycelium : inventaire et méthodes ORM à ajouter à Vesta

Analyse seule : aucun fichier de code n'a été modifié. Source : les fichiers sur disque au 2026-11-06, modifications non commitées comprises (`routes/conv_blocks.py`, `message_helpers.py`…).

## Résumé

**113 requêtes SQL écrites à la main** dans 13 modules. Avec **14 méthodes** de plus dans `vesta/db/db_service.py` (dont 4 variantes courtes : `findOne`, `count`, `exists`, `insertMany`) et 5 vues dans `db/schema.sql`, **96 d'entre elles disparaissent du Python**. Les **17 qui restent** sont des requêtes propres à PostgreSQL (trigrammes, CTE récursives, `LATERAL`, `tableoid`, fonctions de fenêtrage) ou des chemins critiques. Elles passeraient par un seul point d'entrée, `db.query()`.

| # | Motif | Méthode proposée | Requêtes remplacées |
|---|-------|------------------|---------------------|
| 1 | SELECT filtré : colonnes, `ORDER BY`, `LIMIT`, `ANY`, `OR`, `FOR UPDATE` | `find()` / `findOne()` | **33** |
| 2 | UPDATE de plusieurs colonnes, `col = col + n`, `now()`, WHERE composé, `rowcount` | `update()` (+ `db.inc()`, `db.NOW`) | **16** |
| 3 | `count(*)`, `max`, `min`, `sum`, `SELECT 1 … LIMIT 1` | `aggregate()`, `count()`, `exists()` | **14** |
| 4 | INSERT avec `RETURNING`, conflit choisi, JSON, dans une transaction ; inserts par lot | `insert()`, `insertMany()` | **10** |
| 5 | Jointures et `UNION` répétées → vues SQL lues avec `find()` | 5 vues dans `schema.sql` + `find()` | **7** |
| 6 | DELETE sur plusieurs colonnes ou `ANY` | `delete()` | **6** |
| 7 | `INSERT … ON CONFLICT (clé) DO UPDATE` | `upsert()` | **4** |
| 8 | `pg_notify` / `LISTEN` | `notify()`, `listen()` | **4** |
| 9 | `set_config(…, true)` (`SET LOCAL`) | `transaction(**settings)` | **2** |
| — | Transactions sur plusieurs requêtes, `conn` passé de fonction en fonction | `transaction()` (transversal, connexion portée par une `ContextVar`) | 8 blocs, 0 requête en propre |
| — | **Reste en SQL** (justifié en §4) | `query()` (point d'entrée unique) | **17** |
| | **Total** | | **113** |

En plus des 113 requêtes, `find(order=…)` supprime les **9 appels à `getFilters` qui glissent un `ORDER BY` à la place du joiner** (§3.0). `update()` remplace aussi les suites de `edit()` sur la même ligne (par exemple `crons/15mins.py`, trois `edit` d'affilée).

---

## 1. Méthode de comptage

- **Périmètre lu** : `server.py`, `message_helpers.py`, `callManager.py`, `driveManager.py`, `forumManager.py`, `metrics.py`, `permissions.py`, `ws_handlers.py`, `constants.py`, `routes/*.py`, `crons/*.py`, `mcp_server/server.py`, `misc/loader_gen.py`. `tests/`, `venv/` et `__pycache__/` sont exclus.
- **Recherche** : `conn.execute(`, `cur.executemany`, `self.db._do(`, `pool.connection()`, `sql.SQL(`, `psycopg.connect`, plus toute chaîne qui commence par `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH`. J'ai complété avec un parcours AST de chaque fichier, qui donne chaque appel `.execute`/`.executemany` et sa fonction englobante.
- **Une entrée = un site d'appel `execute`**. Deux variantes d'une requête choisies par un `if` (par exemple avec ou sans `before`) comptent deux fois. `insert_message`, qui exécute la même requête sur sa propre connexion ou sur celle de l'appelant, compte une fois. Les trois `LISTEN` du listener des notes comptent une fois. `metrics._scalar` compte une fois par requête qu'on lui passe.
- **Aucun SQL brut** dans `callManager.py`, `permissions.py`, `ws_handlers.py`, `constants.py`, `routes/{calls,conversations,drive,messaging,note_compaction,roles,transport}.py`, `crons/`, `mcp_server/` (client HTTP) ni `misc/loader_gen.py`.

| Fichier | Requêtes |
|---|---|
| `routes/notes_sync.py` | 40 |
| `routes/conv_blocks.py` | 15 |
| `server.py` | 11 |
| `routes/search.py` | 8 |
| `routes/servers.py` | 8 |
| `metrics.py` | 6 |
| `routes/users.py` | 5 |
| `routes/moderation.py` | 5 |
| `driveManager.py` | 4 |
| `routes/workspaces.py` | 4 |
| `message_helpers.py` | 3 |
| `routes/discovery.py` | 3 |
| `forumManager.py` | 1 |
| **Total** | **113** |

---

## 2. L'ORM actuel (`vesta/db/db_service.py`)

Toutes les méthodes passent par `_do(fn)`, qui emprunte une connexion du pool (autocommit, `dict_row`) et réessaie une fois sur `OperationalError`. **Aucune n'accepte de connexion ni de transaction en cours** : deux appels successifs ne voient jamais la même transaction.

| Méthode | Ce qu'elle fait | Ce qu'elle ne sait pas faire |
|---|---|---|
| `getSomething(table, id, selector='id')` | `SELECT * … WHERE selector = %s`, première ligne. `[]` si rien, `None` (exception avalée) si erreur. | Un seul critère d'égalité. Pas de choix de colonnes, pas d'ordre (la « première » ligne est arbitraire), pas de `FOR UPDATE`, pas de transaction. |
| `getAll(table, id, selector='id')` | Pareil, toutes les lignes. | Pareil. |
| `getSomethingProxied(table, proxy, commonTable, id)` | Jointure many-to-many par une table proxy (noms de colonnes imposés). | Seulement ce schéma de jointure-là. Inutilisé dans Mycelium. |
| `getFilters(table, filter, basis=None)` | Liste plate `[col, op, val, joiner, …]`. `op` et `joiner` sont des fragments SQL bruts (garde-fou : pas de `'`, `;`, `--`, `/* */`). `IN` développé en `(%s,%s…)`. `None`/`"true"`/`"false"` mis en dur. | Pas de parenthèses, donc pas de `(a AND b) OR (c AND d)`. Pas de choix de colonnes. `ORDER BY`/`LIMIT` seulement en détournant le joiner (`"order by timestamp"`). `IN` sur une liste vide produit `IN ()`, une erreur de syntaxe avalée qui renvoie `None`. Pas de `FOR UPDATE`, pas de transaction, pas d'agrégat. |
| `insertDict(table, dict, getId=False)` | `INSERT … ON CONFLICT DO NOTHING [RETURNING id]`. | Le conflit est **toujours** ignoré, en silence. Avec `getId=True` et un conflit, `r['id']` lève `TypeError` (`None['id']`). `RETURNING` limité à `id`, ce qui exclut les tables sans colonne `id` (`note_head`, `note_client`, `note_op`). Pas d'insert par lot. Les dict/list ne sont pas adaptés en JSON : l'appelant fait `json.dumps` ou `Jsonb()` lui-même. |
| `insertReplaceDict(table, dict)` | Upsert sur conflit `(id)`. | Seule la clé `id` est possible. Aucune table de Mycelium n'a son upsert sur `id` : ils sont tous sur une contrainte `UNIQUE` composite. |
| `edit(table, id, element, value, selector='id')` | `UPDATE … SET element = %s WHERE selector = %s`. | Une colonne et un critère. Pas d'expression (`col + 1`, `now()`, `GREATEST`). Ne renvoie pas `rowcount`. |
| `deleteSomething(table, id, selector='id')` | `DELETE … WHERE selector = %s`. | Un critère. Pas de `rowcount`. |
| `resetTable`, `init`, `initUniauth`, `createTable`, `getUserCredentials`, `getUser`, `createAccount`, `postUniBridge*`, `getUnibridgeNotifs` | Administration et uniauth. | Hors sujet. |
| `_do(fn)` / `pool` | Échappatoire : n'importe quel SQL sur une connexion empruntée. | C'est par là que passe tout le SQL brut de l'app (`self.db.pool.connection()` dans 100+ sites, `self.db._do` dans 3). |

---

## 3. API proposée

Le style reste celui de Vesta : méthodes du service `DB`, la table en premier argument, des structures Python simples (dict, tuple), des identifiants toujours passés par `sql.Identifier`, des valeurs toujours paramétrées. **Aucune méthode existante ne change** : `getSomething`, `getFilters`, `edit`… restent, pour la compatibilité.

### 3.0 Une grammaire commune pour `where` (utilisée par `find`, `update`, `delete`, `aggregate`…)

```python
{"channel": 12, "deleted": False}            # channel = %s AND deleted = %s
{"parent_folder": None}                      # parent_folder IS NULL
{"uuid": ["a", "b"]}                         # uuid = ANY(%s)  (list/set ; une liste vide donne 0 ligne, pas d'erreur)
{"id": ("<", before)}                        # opérateur, liste blanche : = != < <= > >= like ilike @>
{"seq": ((">", done), ("<=", upto))}         # plusieurs conditions sur une même colonne
{"category": ("!=", None)}                   # IS NOT NULL
{"expiration": (">", db.NOW)}                # now() côté base (horloge de PostgreSQL, pas celle de Python)
{"created_at": ("<", db.now(-COMPACT_AGE))}  # now() + make_interval(secs => %s)
[{"target": a, "is_category": False},        # une LISTE de dicts = OR des AND :
 {"target": b, "is_category": True}]         # (target = %s AND is_category = %s) OR (…)
```

Règles :

- `None` donne `IS NULL`. C'est la sémantique de `IS NOT DISTINCT FROM`, et la colonne reste indexable.
- Les listes passent en `= ANY(%s)` : un seul paramètre, une seule requête préparée, quelle que soit la taille.
- Les opérateurs sont pris dans une liste blanche, au lieu des fragments bruts filtrés par regex de `getFilters`.

`order` : `"id"`, `"-id"` (DESC) ou une liste (`["position", "id"]`). `columns` : liste de colonnes, `*` par défaut.

Le compilateur `_where()` tient en une cinquantaine de lignes, et c'est le seul morceau un peu délicat. Toutes les méthodes ci-dessous l'utilisent.

### 3.1 `transaction(**settings)` : transversal, la pièce maîtresse

```python
@contextmanager
def transaction(self, **settings): ...      # yield conn

with self.db.transaction(statement_timeout="5s"):
    block = self.db.findOne("conv_block", {"id": bid}, lock=True)
    self.db.update("conv_block", {"id": bid}, {"version": self.db.inc(1)})
```

- Emprunte une connexion, ouvre `conn.transaction()`, applique chaque réglage par `set_config(name, value, true)`, et **enregistre la connexion dans une `ContextVar`**.
- Toutes les méthodes de `DB` (les nouvelles et les anciennes, via `_do`) utilisent la connexion de la `ContextVar` quand il y en a une. Il n'y a donc plus de paramètre `conn` à faire passer de fonction en fonction (`insert_message(conn=…)`, `_lock_head(conn, …)`, `notify_sheet(conn, …)`, `_items(conn, …)`, les `read(conn)` de `workspaces.py`…).
- Une transaction imbriquée devient un savepoint (psycopg le fait déjà). Pas de retry sur `OperationalError` à l'intérieur d'une transaction, seulement au moment de l'ouvrir.
- Une `ContextVar` est propre à chaque thread et à chaque tâche asyncio, ce qui convient aux deux modes d'exécution de l'app.

**Ce que ça règle aujourd'hui** :

- `save_block` (`routes/notes_sync.py:549`) appelle `self.db.getSomething` **à l'intérieur** de sa transaction. La lecture part sur une autre connexion du pool : elle ne voit pas la transaction et occupe une deuxième connexion.
- Le `statement_timeout` de `metrics.run_spec` (`metrics.py:461`) **n'est jamais appliqué** (§6).

**Blocs concernés** (8) : `conv_blocks.py:345` (`_change`), `conv_blocks.py:400` (`create_conv_block`), `workspaces.py:220` (`_announce_sheet`), `notes_sync.py:287` (`_maybe_compact`), `:344` (`note_sync`), `:372` (`note_push`), `:543` (`save_block`), `search.py:157` (`global_search`).

### 3.2 `find()` / `findOne()` : **33 requêtes**

```python
def find(self, table, where=None, columns=None, order=None, limit=None, lock=False) -> list[dict]
def findOne(self, table, where=None, columns=None, order=None, lock=False) -> dict | None  # LIMIT 1
```

```python
# moderation.py:276 et :280 (les deux variantes deviennent une seule ligne)
rows = self.db.find("moderation_log", {"server": sid, **({"id": ("<", int(before))} if before else {})},
                    order="-id", limit=lim)
# conv_blocks.py:312-313
blocks = self.db.find("conv_block", {"uuid": block_uuids})
items = self.db.find("conv_block_item", {"block_id": [b["id"] for b in blocks]},
                     columns=["id", "block_id", "data", "author"], order=["position", "id"])
# notes_sync.py:193
head = self.db.findOne("note_head", {"channel": channel}, columns=["seq", "max_clock"], lock=True)
# message_helpers.py:211
rows = self.db.find("notification_override", [{"target": key, "is_category": False},
                                              {"target": cat or -1, "is_category": True}])
```

Remplace : MH-3 · DI-1 · US-3 · MO-1…MO-5 · WS-1, WS-2, WS-3 · CH-2 · CB-1, CB-2, CB-3, CB-4, CB-5, CB-7 · NS-2, NS-3, NS-10, NS-12, NS-13, NS-17, NS-20, NS-21, NS-22, NS-23, NS-24, NS-26, NS-33, NS-35, NS-39 (identifiants en §5). Elle remplace aussi les 9 `getFilters(…, "order by …")`.

`find` est **la** méthode à faire en premier. Combinée à `transaction()`, elle couvre à elle seule près d'un tiers des requêtes et tous les `FOR UPDATE`.

### 3.3 `update()` : **16 requêtes**

```python
def update(self, table, where, values) -> int          # rowcount
db.inc(n, min=None)   # col = col + n   /   col = GREATEST(min, col + n)
db.NOW                # now()
```

```python
# server.py:521, :527, :537
self.db.update("server", {"id": sid}, {"storage_usage": self.db.inc(delta, min=0)})
# notes_sync.py:489 (rowcount utilisé)
written = self.db.update("note_block", {"uuid": u, "channel": ch, "proj_seq": ("<=", seq)},
                         {**values, "proj_seq": seq})
# notes_sync.py:612 + :613 (une boucle d'UPDATE plus un dernier UPDATE deviennent un seul appel)
self.db.update("note_block", {"id": row["id"]}, {**changes, "proj_seq": head["seq"]})
```

`update` reçoit des noms de colonnes en clés de `values`. Ils passent par `sql.Identifier`, ce qui supprime les f-strings `f"UPDATE {table} SET {key} = %s"` (`servers.py:458`, `:558`, `notes_sync.py:612`). Leur sûreté ne repose plus sur des listes blanches en amont.

Remplace : SP-3, SP-4, SP-5 · CH-4, CH-7 · CB-6, CB-11, CB-14 · NS-4, NS-6, NS-15, NS-16, NS-28, NS-34, NS-36, NS-37.

### 3.4 `aggregate()`, `count()`, `exists()` : **14 requêtes**

```python
def aggregate(self, table, where=None, **aggs) -> dict   # aggs : nom=("max","col") | "count"
def count(self, table, where=None) -> int
def exists(self, table, where) -> bool                   # SELECT 1 … LIMIT 1
```

```python
# conv_blocks.py:454
s = self.db.aggregate("conv_block_item", {"block_id": bid}, n="count", last=("max", "position"))
last = s["last"] or 0                                    # coalesce côté Python
# notes_sync.py:281
upto = self.db.aggregate("note_op", {"channel": ch, "seq": ((">", done), ("<=", done + COMPACT_BATCH)),
                                     "created_at": ("<", self.db.now(-COMPACT_AGE))}, seq=("max", "seq"))["seq"]
# notes_sync.py:485
if not self.db.exists("note_op", {"channel": ch, "obj": uuid, "seq": ("<=", seq)}): continue
```

Fonctions en liste blanche : `count`, `sum`, `min`, `max`, `avg`.

Remplace : DI-2, DI-3 · MT-2, MT-3, MT-4 · CB-12 · NS-11, NS-19, NS-27 · SP-6, SP-7 (`exists`) · CH-1, CH-5, CH-6 (via la vue `sidebar_place`, §3.6).

Réserve sur **CH-1** (`_insert_at_end`, `servers.py:53`). L'`INSERT … SELECT coalesce(max(place),0)+1` atomique devient `aggregate` puis `insert` dans une `transaction()`. Deux créations simultanées peuvent alors recevoir la même `place`. Le tri de la barre latérale départage déjà les égalités (place, puis type, puis id : voir `_detach_from_category`), donc l'effet visible est nul. Si ce n'est pas acceptable, CH-1 reste en SQL.

### 3.5 `insert()` / `insertMany()` : **10 requêtes**

```python
def insert(self, table, row, returning=None, onConflict=None)
    # returning : None -> rowcount | "id" -> valeur | ("id","timestamp") ou "*" -> dict | None si ignoré
    # onConflict : None (erreur PostgreSQL, comme en SQL) | "ignore" (DO NOTHING)
def insertMany(self, table, rows, onConflict=None) -> int    # executemany (pipeline psycopg 3)
```

Les valeurs `dict`/`list` sont adaptées automatiquement (`Jsonb`). Cette adaptation vaut pour `insert`, `update`, `upsert`, `find` (opérateur `@>`), etc.

```python
# message_helpers.py:91/93 : plus de branche own/conn, la transaction est implicite
row = self.db.insert("message", message, returning=("id", "timestamp"))
# notes_sync.py:191 : "créé ?" sans colonne id
created = self.db.insert("note_head", {"channel": ch}, onConflict="ignore")
# conv_blocks.py:409
self.db.insertMany("note_spreadsheet_cell", [{"spreadsheet_id": sid, "row_idx": r, "col_idx": c,
                                              "value": cells.get((c, r), ""), "bg_color": fmt.get((c, r))} …])
```

Pourquoi ne pas simplement étendre `insertDict` ? Son `ON CONFLICT DO NOTHING` implicite est dangereux (doublon perdu en silence, puis `TypeError` avec `getId`). Il vaut mieux une méthode neuve où ignorer un conflit est un choix explicite.

Remplace : MH-2 · CB-8, CB-9, CB-10, CB-13 · NS-1, NS-5, NS-29, NS-30, NS-32.

### 3.6 Vues dans `db/schema.sql`, lues avec `find()` : **7 requêtes**

Plutôt que des jointures dans l'ORM (c'est par là que les ORM grossissent), les jointures et `UNION` récurrentes vont **une fois** dans le schéma, sous forme de vues que `find`/`aggregate` lisent comme des tables. PostgreSQL pousse les prédicats dans la vue, donc les plans ne changent pas.

| Vue proposée | Contenu | Remplace |
|---|---|---|
| `sidebar_place(server, category, place)` | `server_cat` (category NULL) `UNION ALL` les 5 tables de salons | CH-1, CH-5, CH-6 (comptées en §3.4) |
| `drive_folder_listing` / `drive_file_listing` | dossier/fichier + `creator_name`/`uploader_name`… + `sort_name = lower(nom)` | DR-2, DR-3 |
| `online_server_member(server, userid)` | `DISTINCT active_client ⋈ accessserver` | DR-4 |
| `op_serv_member(server, account)` | `op_servs ⋈ accessServer` | SP-1, SP-2 |
| `status_recipient(watched, id, userid, server, idle)` | abonnés `UNION` clients propres | SP-10, SP-11 |

```python
folders = self.db.find("drive_folder_listing", {"drive_channel": d, "parent_folder": parent}, order="sort_name")
recipients = self.db.find("status_recipient", {"watched": uid})
```

`status_recipient` est lue à chaque changement de statut : à vérifier avec `EXPLAIN` que le prédicat `watched = %s` descend bien dans les deux branches de l'`UNION`. C'est normalement le cas.

### 3.7 `delete()` : **6 requêtes**

```python
def delete(self, table, where) -> int    # rowcount
self.db.delete("notification_override", {"target": cat["id"], "is_category": True})   # servers.py:584
self.db.delete("note_op", {"channel": ch, "seq": list(removed)})                       # notes_sync.py:297
```

Remplace : US-2, US-4 · CH-3, CH-8 · CB-15 · NS-14.

### 3.8 `upsert()` : **4 requêtes**

```python
def upsert(self, table, row, key, update=None, returning=None)
    # ON CONFLICT (key…) DO UPDATE SET c = EXCLUDED.c pour c dans update (par défaut : colonnes hors clé)
```

```python
# users.py:208
row = self.db.upsert("notification_override", {**key, **values},
                     key=("account", "target", "is_category"), returning="*")
# users.py:36-50 : getFilters + UPDATE brut / insertDict (avec une course) deviennent un seul appel
self.db.upsert("device_token", {"account": uid, "token": token, "platform": platform,
                                "updated_at": self.db.NOW}, key=("account", "token"))
```

`insertReplaceDict(t, d)` devient un cas particulier, `upsert(t, d, key="id")`.

Remplace : US-1 · US-5 · NS-8, NS-25.

### 3.9 `notify()` / `listen()` : **4 requêtes**

```python
def notify(self, channel, payload)       # SELECT pg_notify(%s, %s) ; dans une transaction : envoyé au commit
def listen(self, *channels, onConnect=None)  # générateur de Notify sur une connexion dédiée hors pool,
                                             # reconnexion automatique, onConnect() à chaque (re)connexion
```

`onConnect` correspond à ce que fait `_listen` (`notes_sync.py:664-690`) : rattraper les ops stockées pendant la coupure et faire relire les feuilles. Le listener se réduit à sa boucle de dispatch.

Remplace : NS-7, NS-18, NS-40 (`notify`) · NS-38 (`listen`).

### 3.10 `transaction(**settings)` : **2 requêtes**

`set_config(…, true)` devient un argument de `transaction()` (§3.1) :

```python
with self.db.transaction(**{"pg_trgm.word_similarity_threshold": WORD_SIM_THRESHOLD}):   # search.py:158
with self.db.transaction(statement_timeout=STATEMENT_TIMEOUT):                          # metrics.py:461
```

Remplace : SR-1 (`search.py:158`), MT-5.

### 3.11 `query()` : point d'entrée unique pour le SQL qui reste

```python
def query(self, text, params=None, one=False)    # list[dict] | dict | None, dans la transaction courante
```

Il remplace le motif `with self.db.pool.connection() as conn: conn.execute(...).fetchall()` des 17 requêtes restantes. Recommandation : regrouper ces 17 requêtes dans un module `queries.py` (ou des fichiers `.sql`) pour que le SQL de l'app ait une seule adresse. `_PATH_SQL` (`driveManager.py:20`) et `_PATHS_SQL` (`search.py:93`) sont la même CTE récursive, à fusionner.

### 3.12 Ordre d'implémentation suggéré

1. `_where()` + `find`/`findOne` + `transaction()` (ContextVar) : 33 requêtes et tous les blocs transactionnels.
2. `update` (+ `inc`, `NOW`, `now()`), `delete`, `insert`/`insertMany` (+ JSON automatique) : 32 de plus.
3. `aggregate`/`count`/`exists`, `upsert` : 18 de plus.
4. Les 5 vues, `notify`/`listen`, `query` : le reste.

---

## 4. Ce qui reste en SQL : 17 requêtes

| Id | Requête | Pourquoi elle reste |
|---|---|---|
| MH-1 | `_lookupMessagePlace`, `message_helpers.py:63` | `tableoid::regclass` sur la table mère `conversationElement` + `LEFT JOIN` conditionnels. Héritage PostgreSQL propre au schéma, et chemin critique (appelé à chaque frappe pour l'indicateur de saisie). Une méthode ORM « de quelle table fille vient cet id » ne servirait qu'ici. |
| FM-1 | `_forumPostStarters`, `forumManager.py:66` | `DISTINCT ON` + `count(*) OVER (PARTITION BY)` : premier message et nombre de messages de chaque post en une requête. Le découper en `find` ferait N+1 requêtes. |
| MT-1 | `pg_size_pretty(pg_database_size(…))`, `metrics.py:224` | Fonction système, pas une table. |
| MT-6 | Requête compilée par `compile_spec`, `metrics.py:462` | `metrics.py` est déjà un mini-compilateur SQL (dimensions, mesures, `GROUP BY`, `HAVING` k-anonymat). Il ne gagnerait rien à passer par l'ORM. |
| DR-1 | `_PATH_SQL`, `driveManager.py:20` | `WITH RECURSIVE` (ancêtres d'un dossier). À fusionner avec SR-6. |
| SR-2…SR-5 | `_CHANNELS_SQL`, `_POSTS_SQL`, `_FILES_SQL`, `_FOLDERS_SQL`, `search.py:160-163` | Recherche trigramme : `word_similarity`, opérateur `<%`, `f_unaccent`, `UNION ALL` de 5 branches triées et limitées chacune (pour utiliser les index GIN). Requêtes de performance par nature. |
| SR-6 | `_PATHS_SQL`, `search.py:169` | `WITH RECURSIVE`, version par lot de DR-1. |
| SR-7, SR-8 | `_FRECENCY_*_SQL`, `search.py:207-208` | `SUM(EXP(-age/τ))`, `GROUP BY`, `interval`, `COALESCE` sur une jointure. Calcul de score, pas du CRUD. |
| WS-4 | `sweep_note_images`, `workspaces.py:974` | `starts_with` + `EXISTS` corrélé sur `note_op` avec intervalle. Une sous-requête dans l'ORM serait plus d'API que de requêtes remplacées. |
| NS-9 | `_stored_chars`, `notes_sync.py:266` | `unnest(%s::bigint[]) CROSS JOIN LATERAL (… ORDER BY clock DESC LIMIT 1)` : la dernière op ≤ k pour chaque k, en une requête indexée. Cœur du CRDT. |
| NS-31 | `save_block`, `notes_sync.py:555` | `max(op->>'v' COLLATE "C")` filtré sur `op->>'t'`/`op->>'f'` : extraction jsonb + collation binaire. Une alternative de schéma serait de tenir la dernière clé de position dans `note_head`. |
| SP-8, SP-9 | `_isFilepathOrphaned`, `server.py:596`, `:601` (message) | `attachments::text LIKE '%…%'` : la colonne est en `json`, pas en `jsonb`. Le seul moyen est un cast puis un parcours complet de la table. **Si `message.attachments` passe en `jsonb`**, les deux deviennent `exists("message", {"attachments": ("@>", [{"filepath": fp}]), "id": ("!=", x)})`, ce qui rend la requête indexable (GIN) et exacte (plus de faux positif sur un préfixe de chemin). Changement de schéma à décider à part. |

---

## 5. Inventaire détaillé

Légende de la colonne « SQL hors ORM » : **J** jointure · **U** UNION · **ANY** `= ANY(%s)` · **R** `RETURNING` · **FU** `FOR UPDATE` · **TX** dans une transaction sur plusieurs requêtes · **AGG** agrégat (`count`/`max`/`sum`/`coalesce`) · **OB** `ORDER BY` · **L** `LIMIT` · **OC** `ON CONFLICT` · **JS** jsonb (`->>`, `Jsonb`) · **EXPR** expression dans `SET`/`WHERE` (`col+1`, `GREATEST`, `now()`) · **MW** WHERE sur plusieurs colonnes ou avec un opérateur non `=` · **MC** SET de plusieurs colonnes · **BATCH** `executemany` · **DYN** noms de table ou de colonne en f-string · **OR** disjonction parenthésée.

### `server.py` : 11

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| SP-1 | 456 | `_refreshAdminCache` | comptes membres d'un serveur « op » | J, DISTINCT | vue `op_serv_member` + `find` |
| SP-2 | 475 | `_hasAdminRight` | serveurs « op » d'un compte (appelée en N+1 par SP-1) | J, MW | vue `op_serv_member` + `find` |
| SP-3 | 521 | `_adjustStorage` | quota utilisateur += delta, plancher 0 | EXPR (`GREATEST`) | `update` + `inc(min=0)` |
| SP-4 | 527 | `_adjustStorage` | quota serveur += delta, plancher 0 | EXPR | `update` + `inc(min=0)` |
| SP-5 | 537 | `_adjustUserStorage` | idem SP-3 | EXPR | `update` + `inc(min=0)` |
| SP-6 | 581 | `_isFilepathOrphaned` | `drive_file` avec même chemin, autre id | MW (`!=`), déjà possible avec `getFilters` | `exists` |
| SP-7 | 586 | `_isFilepathOrphaned` | `drive_file` avec même chemin | aucun : `getFilters` suffit déjà | `exists` |
| SP-8 | 596 | `_isFilepathOrphaned` | message dont les pièces jointes citent le chemin, autre id | cast `::text`, `LIKE` sur json | **reste SQL** (§4) |
| SP-9 | 601 | `_isFilepathOrphaned` | idem sans exclusion | cast, `LIKE` | **reste SQL** (§4) |
| SP-10 | 975 | `sendStatusUpdates` | clients à prévenir d'un changement de statut | J, U | vue `status_recipient` + `find` |
| SP-11 | 991 | `sendStatusUpdatesAsync` | idem (même constante `STATUS_RECIPIENTS_QUERY`) | J, U | vue `status_recipient` + `find` |

### `message_helpers.py` : 3

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| MH-1 | 63 | `_lookupMessagePlace` | quelle table fille contient cet id, et son parent | `tableoid`, J conditionnelle, `COALESCE`, L | **reste SQL** (§4) |
| MH-2 | 91/93 | `insert_message` | insère un message et renvoie id + timestamp, éventuellement dans la transaction de l'appelant | R (2 colonnes), TX (`conn=`) | `insert(returning=(…))` + `transaction()` |
| MH-3 | 211 | `notifyChannelMesage` | réglages de notification du salon **ou** de sa catégorie | OR | `find(where=[{…},{…}])` |

### `forumManager.py` : 1

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| FM-1 | 66 | `_forumPostStarters` | premier message et nombre de messages de chaque post d'un forum | `DISTINCT ON`, fenêtre, sous-requête, OB | **reste SQL** |

### `metrics.py` : 6

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| MT-1 | 224 (via `_scalar` 184) | `_provider_storage` | taille de la base | fonctions système | **reste SQL** |
| MT-2 | 226 | `_provider_storage` | somme et nombre de `drive_file` | AGG | `aggregate(s=("sum","size"), c="count")` |
| MT-3 | 229 | `_provider_storage` | somme des quotas utilisateurs | AGG | `aggregate` |
| MT-4 | 231 | `_provider_storage` | somme des quotas serveurs | AGG | `aggregate` |
| MT-5 | 461 | `run_spec._exec` | `statement_timeout` local | `set_config` (**sans effet aujourd'hui**, §6) | `transaction(statement_timeout=…)` |
| MT-6 | 462 | `run_spec._exec` | requête analytique compilée | AGG, GROUP BY, HAVING, OB, L, DYN | **reste SQL** |

### `driveManager.py` : 4

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| DR-1 | 114 (`_PATH_SQL` l. 20) | `_path` | chemin racine → dossier | `WITH RECURSIVE`, OB | **reste SQL** (à fusionner avec SR-6) |
| DR-2 | 119 (`_FOLDERS_SQL` l. 31) | `_listing` | sous-dossiers + nom du créateur, triés | J (LEFT), `IS NOT DISTINCT FROM`, OB `lower()` | vue `drive_folder_listing` + `find` |
| DR-3 | 120 (`_FILES_SQL` l. 37) | `_listing` | fichiers + nom de l'uploader, triés | idem | vue `drive_file_listing` + `find` |
| DR-4 | 143 (`_ONLINE_MEMBERS_SQL` l. 45) | `notify_changed` | membres connectés du serveur | J, DISTINCT | vue `online_server_member` + `find` |

### `routes/discovery.py` : 3

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| DI-1 | 232 | `create_invitation` | invitation encore valide pour cette cible | MW, `now()`, `IS NOT DISTINCT FROM`, L | `findOne(…, {"expiration": (">", db.NOW), "channel": None…})` |
| DI-2 | 276 | `get_dashboard` | nombre de comptes Mycelium | AGG | `count` |
| DI-3 | 281 | `get_dashboard` | nombre de comptes uniauth (`self.uniauth`) | AGG | `count` (sur `self.uniauth`, même classe `DB`) |

### `routes/users.py` : 5

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| US-1 | 43 | `register_device` | met à jour plateforme et date d'un jeton existant (après un `getFilters`, sinon `insertDict`) | MC, EXPR `NOW()`, MW, course lecture puis écriture | `upsert(key=("account","token"))` |
| US-2 | 66 | `unregister_device` | supprime un jeton | MW | `delete` |
| US-3 | 188 | `set_notification_override` | réglage existant (3 colonnes) | MW (déjà possible avec `getFilters`) | `findOne` |
| US-4 | 205 | `set_notification_override` | supprime un réglage revenu à sa valeur par défaut | MW | `delete` |
| US-5 | 208 | `set_notification_override` | upsert du réglage | OC composite, `DO UPDATE`, R `*` | `upsert(returning="*")` |

### `routes/moderation.py` : 5

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| MO-1 | 276 | `get_moderation_log` | page suivante du journal (keyset `id < before`) | MW `<`, OB DESC, L | `find(order="-id", limit=)` |
| MO-2 | 280 | `get_moderation_log` | première page | OB, L | `find` (fusionnée avec MO-1) |
| MO-3 | 386 | `get_reports` | signalements par statut | OB, L | `find` |
| MO-4 | 541 | `get_platform_action_log` | page suivante | MW `<`, OB, L | `find` |
| MO-5 | 545 | `get_platform_action_log` | première page | OB, L | `find` (fusionnée avec MO-4) |

### `routes/workspaces.py` : 4

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| WS-1 | 221 | `_announce_sheet` | verrouille la feuille le temps de lire puis d'annoncer | FU, TX | `findOne(lock=True)` + `transaction()` |
| WS-2 | 232 | `_announce_cell.read` | lit une cellule dans la transaction | MW (3 col.), colonnes choisies, TX | `findOne(columns=…)` |
| WS-3 | 403 | `save_spreadsheet_col_width.read` | lit une largeur de colonne dans la transaction | MW, TX | `findOne` |
| WS-4 | 974 | `sweep_note_images` | images de la note encore affichées ou supprimées récemment | `starts_with`, `EXISTS` corrélé, intervalle | **reste SQL** |

### `routes/search.py` : 8

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| SR-1 | 158 | `global_search` | seuil `pg_trgm` local | `set_config`, TX | `transaction(**{"pg_trgm.word_similarity_threshold": …})` |
| SR-2 | 160 | `global_search` | salons (5 tables) | trigrammes, U, J, OB, L | **reste SQL** |
| SR-3 | 161 | `global_search` | posts de forum | trigrammes, J, OB, L | **reste SQL** |
| SR-4 | 162 | `global_search` | fichiers | trigrammes, J, OB, L | **reste SQL** |
| SR-5 | 163 | `global_search` | dossiers | trigrammes, J, OB, L | **reste SQL** |
| SR-6 | 169 | `global_search` | chemins des dossiers parents | `WITH RECURSIVE`, ANY | **reste SQL** |
| SR-7 | 207 | `get_frecency` | score de fréquence-récence par lieu | AGG `SUM(EXP())`, GROUP BY, OB, L | **reste SQL** |
| SR-8 | 208 | `get_frecency` | score par serveur | AGG, J, `COALESCE`, GROUP BY | **reste SQL** |

### `routes/servers.py` : 8

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| CH-1 | 53 | `_insert_at_end` | insère un salon ou une catégorie en fin de barre latérale | `INSERT … SELECT`, AGG, U (6 tables), R, DYN | vue `sidebar_place` + `aggregate` + `insert` dans `transaction()` (réserve §3.4) |
| CH-2 | 156 | `get_serv_content` | chats des salons vocaux | ANY | `find({"vocal": ids})` |
| CH-3 | 440 | `edit_server_channel` | supprime les réglages de notification d'un salon | MW (bool) | `delete` |
| CH-4 | 458 | `edit_server_channel` | change catégorie et place en une fois | MC, DYN | `update` |
| CH-5 | 492 | `_duplicate_channel` | place suivante dans la liste | AGG `min`, U, MW `>` | vue `sidebar_place` + `aggregate` |
| CH-6 | 533 | `_detach_from_category` | place suivante au premier niveau | AGG, U, MW | vue `sidebar_place` + `aggregate` |
| CH-7 | 558 | `_detach_from_category` | sort un salon de sa catégorie | MC, DYN | `update` |
| CH-8 | 584 | `edit_server_category` | supprime les réglages de notification d'une catégorie | MW (bool) | `delete` |

### `routes/conv_blocks.py` : 15

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| CB-1 | 284 | `_items` | items d'un bloc, ordonnés | colonnes, OB à 2 clés, TX (`conn`) | `find(order=["position","id"])` |
| CB-2 | 301 | `_state` | le bloc, dans la transaction | TX | `findOne` |
| CB-3 | 312 | `read_block_states` | blocs par lot d'uuids | ANY | `find({"uuid": uuids})` |
| CB-4 | 313 | `read_block_states` | items de ces blocs | ANY, OB | `find` |
| CB-5 | 346 | `_change` | verrouille le bloc | FU, TX | `findOne(lock=True)` |
| CB-6 | 348 | `_change` | `version = version + 1` | EXPR | `update(…, {"version": inc(1)})` |
| CB-7 | 370 | `_get_item` | verrouille l'item du bloc | FU, MW | `findOne(lock=True)` |
| CB-8 | 404 | `create_conv_block` | crée la feuille du message | R, TX | `insert(returning="id")` |
| CB-9 | 409 | `create_conv_block` | cellules du modèle | BATCH | `insertMany` |
| CB-10 | 419 | `create_conv_block` | crée le bloc | R, JS (`Jsonb`), TX | `insert` (JSON automatique) |
| CB-11 | 444 | `edit_conv_block.apply` | réglages du bloc | JS, TX | `update` |
| CB-12 | 454 | `add_conv_block_item.apply` | nombre d'items et dernière position | AGG `count`, `coalesce(max)` | `aggregate` |
| CB-13 | 459 | `add_conv_block_item.apply` | ajoute l'item | JS, TX | `insert` |
| CB-14 | 472 | `edit_conv_block_item.apply` | modifie l'item | JS, TX | `update` |
| CB-15 | 482 | `delete_conv_block_item.apply` | supprime l'item | TX | `delete` |

### `routes/notes_sync.py` : 40

| Id | Ligne | Fonction | Ce que ça fait | SQL hors ORM | Couvert par |
|---|---|---|---|---|---|
| NS-1 | 191 | `_lock_head` | crée la tête de la note si absente (`rowcount`) | OC DO NOTHING, table sans `id`, TX | `insert(onConflict="ignore")` |
| NS-2 | 193 | `_lock_head` | verrouille la tête | FU, colonnes | `findOne(lock=True)` |
| NS-3 | 202 | `_import_blocks` | blocs non supprimés, par id | MW (`NOT`), OB | `find(order="id")` |
| NS-4 | 225 | `_import_blocks` | clés de position et `proj_seq` (boucle) | MC | `update` |
| NS-5 | 241 | `_store` | stocke les ops du lot | BATCH, table sans `id` | `insertMany` |
| NS-6 | 243 | `_store` | avance la tête | MC, table sans `id` | `update` |
| NS-7 | 244 | `_store` | `pg_notify('note_ops')` | NOTIFY, TX | `notify` |
| NS-8 | 258 | `_append_server_ops` | `max_clock` du client serveur | OC composite DO UPDATE | `upsert(key=("channel","client_id"))` |
| NS-9 | 266 | `_stored_chars` | quelles horloges sont des caractères stockés | `unnest`, `LATERAL`, JS, OB, L | **reste SQL** |
| NS-10 | 277 | `_maybe_compact` | seq et compacted_seq | colonnes | `findOne` |
| NS-11 | 281 | `_maybe_compact` | dernière seq compactable | AGG `max`, MW (plages), intervalle | `aggregate` + `db.now(-s)` |
| NS-12 | 288 | `_maybe_compact` | verrouille la tête | FU, TX | `findOne(lock=True)` |
| NS-13 | 291 | `_maybe_compact` | ops de la plage | MW (plage), OB | `find` |
| NS-14 | 297 | `_maybe_compact` | supprime les ops absorbées | ANY, TX | `delete` |
| NS-15 | 299 | `_maybe_compact` | réécrit une op fusionnée (boucle) | MC, MW, JS | `update` |
| NS-16 | 301 | `_maybe_compact` | marque la plage compactée | TX | `update` |
| NS-17 | 309 | `_ops_after` | ops après seq, éventuellement limitées | MW `>`, OB, L (f-string) | `find(order="seq", limit=)` |
| NS-18 | 318 | `notify_sheet` | `pg_notify('note_sheet')` | NOTIFY, TX (`conn` passé) | `notify` |
| NS-19 | 343 | `note_sync` | la note a-t-elle une tête ? | `SELECT 1` | `exists` |
| NS-20 | 347 | `note_sync` | seq de la tête | colonnes | `findOne` |
| NS-21 | 349 | `note_sync` | état projeté de chaque bloc | colonnes | `find(columns=…)` |
| NS-22 | 374 | `note_push` | verrouille le client | FU, MW, TX | `findOne(lock=True)` |
| NS-23 | 392 | `note_push` | horloges déjà stockées | ANY, MW | `find` |
| NS-24 | 402 | `note_push` | `max_clock` des autres clients | ANY | `find` |
| NS-25 | 434 | `note_push` | `max_clock` de ce client | OC composite DO UPDATE | `upsert` |
| NS-26 | 480 | `note_project` | seq de la tête | — | `findOne` |
| NS-27 | 485 | `note_project` | le bloc est-il dans le journal ? | MW `<=`, L | `exists` |
| NS-28 | 489 | `note_project` | écrit la projection si elle n'est pas plus ancienne (`rowcount`) | MC dynamique, MW `<=`, DYN | `update` (renvoie `rowcount`) |
| NS-29 | 495 | `note_project` | sinon l'insère, sauf si l'uuid appartient à une autre note | OC DO NOTHING, DYN | `insert(onConflict="ignore")` |
| NS-30 | 522 | `note_ensure_block` | réserve la ligne d'un bloc base ou feuille | OC DO NOTHING | `insert(onConflict="ignore")` |
| NS-31 | 555 | `save_block` | plus grande clé de position du journal | AGG sur `op->>'v' COLLATE "C"`, JS | **reste SQL** |
| NS-32 | 574 | `save_block` | crée le bloc | R, DYN | `insert(returning="id")` |
| NS-33 | 579 | `save_block` | le bloc par uuid, dans la transaction | TX | `findOne` |
| NS-34 | 584 | `save_block` | suppression logique | MC | `update` |
| NS-35 | 604 | `save_block` | ops d'insertion du bloc | MW, JS (`op->>'t' = 'ins'`) | `find({"op": ("@>", {"t": "ins"})})` (op est en `jsonb`) |
| NS-36 | 612 | `save_block` | une colonne modifiée (boucle) | DYN | `update` (fusionnée avec NS-37) |
| NS-37 | 613 | `save_block` | `proj_seq` | — | `update` (fusionnée avec NS-36) |
| NS-38 | 669-671 | `_listen` | `LISTEN` ×3, connexion dédiée hors pool | LISTEN | `listen(…, onConnect=)` |
| NS-39 | 709 | `_head_seq` | seq de la tête | — | `findOne` |
| NS-40 | 809 | `_pg_notify_presence` | `pg_notify('note_presence')` par lot | NOTIFY | `notify` |

### Récapitulatif par méthode

Préfixes : SP `server.py` · MH `message_helpers.py` · FM `forumManager.py` · MT `metrics.py` · DR `driveManager.py` · DI `discovery.py` · US `users.py` · MO `moderation.py` · WS `workspaces.py` · SR `search.py` · CH `servers.py` · CB `conv_blocks.py` · NS `notes_sync.py`.

| Méthode | Requêtes (Id) | Nb |
|---|---|---|
| `find`/`findOne` | MH-3, DI-1, US-3, MO-1…5, WS-1…3, CH-2, CB-1…5, CB-7, NS-2, 3, 10, 12, 13, 17, 20, 21, 22, 23, 24, 26, 33, 35, 39 | 33 |
| `update` | SP-3, 4, 5, CH-4, CH-7, CB-6, 11, 14, NS-4, 6, 15, 16, 28, 34, 36, 37 | 16 |
| `aggregate`/`count`/`exists` | SP-6, SP-7, DI-2, DI-3, MT-2, 3, 4, CB-12, NS-11, 19, 27, CH-1, CH-5, CH-6 | 14 |
| `insert`/`insertMany` | MH-2, CB-8, 9, 10, 13, NS-1, 5, 29, 30, 32 | 10 |
| vues + `find` | SP-1, SP-2, SP-10, SP-11, DR-2, DR-3, DR-4 | 7 |
| `delete` | US-2, US-4, CH-3, CH-8, CB-15, NS-14 | 6 |
| `upsert` | US-1, US-5, NS-8, NS-25 | 4 |
| `notify`/`listen` | NS-7, 18, 38, 40 | 4 |
| `transaction(**settings)` | SR-1, MT-5 | 2 |
| **reste SQL** (`query`) | MH-1, FM-1, MT-1, MT-6, DR-1, SR-2…8, WS-4, NS-9, NS-31, SP-8, SP-9 | 17 |
| **Total** | | **113** |

---

## 6. Observations relevées en passant (non corrigées, hors périmètre)

1. **`metrics.py:461` : le `statement_timeout` des métriques n'a aucun effet.** `set_config(…, true)` vaut `SET LOCAL`, qui ne dure que la transaction en cours. Or `_exec` tourne sur une connexion en autocommit **sans** `conn.transaction()`. Le `SELECT set_config` est donc sa propre transaction, et la requête analytique suivante part sans limite de durée. `search.py:157` fait correctement l'équivalent : il ouvre une transaction et l'explique en commentaire. Correctif d'une ligne (envelopper `_exec` dans `with conn.transaction():`), ou `transaction(statement_timeout=…)` une fois l'API en place.
2. **`save_block` (`notes_sync.py:549`)** lit avec `self.db.getSomething` à l'intérieur de sa transaction. La lecture passe par une autre connexion du pool : elle ne voit pas la transaction et immobilise une deuxième connexion. La `ContextVar` de `transaction()` règle le problème sans toucher l'appel.
3. **`insertDict(getId=True)`** lève `TypeError` en cas de conflit : `ON CONFLICT DO NOTHING` ne renvoie aucune ligne, puis `r['id']` est évalué sur `None`. Sans `getId`, un doublon est perdu sans trace.
4. **`getFilters` avec `IN` sur une liste vide** produit `IN ()`, une erreur de syntaxe. L'erreur est avalée et la méthode renvoie `None`. La plupart des appelants font `or []`, ce qui masque le problème.
5. **Les méthodes de lecture de Vesta avalent les exceptions** (elles affichent l'erreur et renvoient `None`) et renvoient `[]` quand il n'y a pas de résultat. Les nouvelles méthodes devraient laisser remonter les erreurs et renvoyer `None` ou `[]` de façon cohérente.
6. **`_refreshAdminCache`** fait une requête par administrateur candidat (`_hasAdminRight`, N+1), puis appelle `checkAccessRights` deux fois par serveur. La vue `op_serv_member` permet de tout charger en une requête.
7. **`register_device`** (`users.py:36-50`) fait une lecture puis une écriture : deux appels simultanés pour le même jeton peuvent tous les deux insérer. La contrainte `UNIQUE (account, token)` fait échouer le second, en silence à cause du `DO NOTHING` de `insertDict`. Un `upsert` règle le cas.
8. **`message.attachments` est en `json`**, pas en `jsonb`. La recherche de fichiers orphelins fait un `LIKE '%chemin%'` sur le texte de toute la table : parcours complet, et faux positif possible quand un chemin est le préfixe d'un autre. Le passage en `jsonb` et `@>` est expliqué en §4.
9. **Adaptation JSON automatique** (§3.5) : `Jsonb` vise les colonnes `jsonb`. Pour les colonnes `json` (`message.attachments`), il faut vérifier que l'affectation `jsonb` → `json` est acceptée sans cast explicite, ou utiliser `Json` selon le type de la colonne. À tester au moment de l'implémentation.
