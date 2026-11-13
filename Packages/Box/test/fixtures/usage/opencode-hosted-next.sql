-- Another release channel's database (opencode-next.db), opencode 1's table only: a message
-- in opencode.db too counts once: the first database's, by path (this one sorts first).
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
INSERT INTO message VALUES ('m-zen-2','s3',1794398400000,1794398400000,'{"role":"assistant","providerID":"opencode","modelID":"gpt-5.5","cost":0.125,"tokens":{"total":1500}}');
INSERT INTO message VALUES ('m-next-1','s3',1794484800000,1794484800000,'{"role":"assistant","providerID":"opencode","modelID":"gpt-5.5","cost":0.375,"tokens":{"total":3000}}');
