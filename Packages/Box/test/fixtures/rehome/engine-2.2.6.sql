PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `account_state` (
          `id` integer PRIMARY KEY,
          `active_account_id` text,
          `active_org_id` text,
          CONSTRAINT `fk_account_state_active_account_id_account_id_fk` FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON DELETE SET NULL
        );
CREATE TABLE `account` (
          `id` text PRIMARY KEY,
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `control_account` (
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `active` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
        );
CREATE TABLE `credential` (
          `id` text PRIMARY KEY,
          `integration_id` text,
          `label` text NOT NULL,
          `value` text NOT NULL,
          `connector_id` text,
          `method_id` text,
          `active` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `event_sequence` (
          `aggregate_id` text PRIMARY KEY,
          `seq` integer NOT NULL,
          `owner_id` text
        );
INSERT INTO event_sequence VALUES('@ROOT@',0,NULL);
INSERT INTO event_sequence VALUES('ses_e2c1dd5f3ffeYix4zyU56M9is1',31,NULL);
INSERT INTO event_sequence VALUES('ses_e2c1dc861ffeU6A6f6us8HLtRt',34,NULL);
INSERT INTO event_sequence VALUES('ses_e2c1dac25ffenw3pfBTEa9Jzzl',32,NULL);
INSERT INTO event_sequence VALUES('ses_e2c1dac23ffeO4w7O36uHI4BsC',2,NULL);
INSERT INTO event_sequence VALUES('ses_e2c1dabd8ffeHQ4oqvqnwI5Ife',30,NULL);
CREATE TABLE `event` (
          `id` text PRIMARY KEY,
          `aggregate_id` text NOT NULL,
          `seq` integer NOT NULL,
          `created` integer DEFAULT 0 NOT NULL,
          `type` text NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
        );
CREATE TABLE `job` (
          `notification_id` text PRIMARY KEY,
          `id` text NOT NULL,
          `session_id` text NOT NULL,
          `child_session_id` text,
          `kind` text NOT NULL,
          `title` text,
          `status` text NOT NULL,
          `output` text,
          `error` text,
          `recovery` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `kv` (
          `key` text PRIMARY KEY,
          `value` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `permission` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `action` text NOT NULL,
          `resource` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO permission VALUES('psv_1d3e243bc002uTr3G5yluYSgCX','@ID:@S@/Chats/c1@','shell','ls *',1794556183484,1794556183484);
CREATE TABLE `project_directory` (
          `project_id` text NOT NULL,
          `directory` text NOT NULL,
          `type` text,
          `strategy` text,
          `time_created` integer NOT NULL,
          CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`),
          CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `time_active` integer DEFAULT 0 NOT NULL,
          `time_archived` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        );
INSERT INTO project VALUES('@ROOT@','@HOME@/proj','git',NULL,NULL,NULL,NULL,1794556176922,1794556176922,NULL,1794556176926,NULL,'[]',NULL);
INSERT INTO project VALUES('@ID:@S@/Chats/c1@','@S@/Chats/c1',NULL,NULL,NULL,NULL,NULL,1794556180386,1794556180386,NULL,1794556180395,NULL,'[]',NULL);
INSERT INTO project VALUES('@ID:@HOME@/Projects/plain@','@HOME@/Projects/plain',NULL,NULL,NULL,NULL,NULL,1794556187613,1794556187613,NULL,1794556187615,NULL,'[]',NULL);
CREATE TABLE `schedule` (
          `id` text PRIMARY KEY,
          `session_id` text,
          `name` text,
          `action` text NOT NULL,
          `check` text,
          `when` text NOT NULL,
          `tz` text NOT NULL,
          `status` text DEFAULT 'active' NOT NULL,
          `next_due_at` integer,
          `ends_at` integer,
          `remaining_runs` integer,
          `run_count` integer DEFAULT 0 NOT NULL,
          `checks` integer DEFAULT 0 NOT NULL,
          `failures` integer DEFAULT 0 NOT NULL,
          `last_fired_at` integer,
          `last_message_id` text,
          `last_outcome` text,
          `retry_at` integer,
          `state` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_schedule_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `blob_ref` (
          `session_id` text NOT NULL,
          `message_id` text NOT NULL,
          `hash` text NOT NULL,
          `seq` integer NOT NULL,
          CONSTRAINT `blob_ref_pk` PRIMARY KEY(`session_id`, `message_id`, `hash`),
          CONSTRAINT `fk_blob_ref_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE,
          CONSTRAINT `fk_blob_ref_hash_blob_hash_fk` FOREIGN KEY (`hash`) REFERENCES `blob`(`hash`) ON DELETE CASCADE
        );
CREATE TABLE `blob` (
          `hash` text PRIMARY KEY,
          `mime` text NOT NULL,
          `bytes` integer NOT NULL,
          `width` integer,
          `height` integer,
          `data` blob NOT NULL,
          `time_created` integer NOT NULL
        );
CREATE TABLE `instruction_blob` (
          `hash` text PRIMARY KEY,
          `value` text
        );
INSERT INTO instruction_blob VALUES('1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2','{"total":8,"shown":8,"namespaces":[{"name":"opencode","description":"Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.","count":8,"entries":[{"path":"opencode.list_mcp_resources","line":"  - tools.opencode.list_mcp_resources({\n  /** MCP server name as configured. Omit to list every server. */\n  server?: string,\n}): Promise<{\n  resources: Array<{\n      server: string,\n      name: string,\n      uri: string,\n      description?: string,\n      mimeType?: string,\n    }>,\n  templates: Array<{\n      server: string,\n      name: string,\n      uriTemplate: string,\n      description?: string,\n      mimeType?: string,\n    }>,\n}> // List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is no..."},{"path":"opencode.models","line":"  - tools.opencode.models({\n  /** Text to search for in model names and IDs. */\n  query?: string,\n  /** Provider ID or name to filter by. Try your own provider first. */\n  provider?: string,\n  /**\n   * Which kind of model to list. Defaults to \"chat\".\n   * \"chat\": a language model (LLM). Powers sessions, agents and subagents, and can call tools.\n   * \"image\": generates or edits images from a prompt. It can''t chat or call tools.\n   */\n  type?: \"chat\" | \"image\",\n  /** Include older versions of each model family. By default only the newest version is listed. */\n  all?: boolean,\n  /** Maximum number of models to return. Defaults to 20. @integer @minimum 1 @maximum 100 */\n  limit?: number,\n  /** Number of models to skip, for paging through results. @integer @minimum 0 */\n  offset?: number,\n}): Promise<{\n  /** Matching models grouped by provider. Your own provider comes first. */\n  providers: Array<{\n      id: string,\n      name: string,\n      /** Newest first. */\n      models: Array<{\n          /** providerID/modelID */\n          id: string,\n          name: string,\n          /** Release date as a Unix timestamp in milliseconds, or 0 when unknown. */\n          released: number,\n          variants: Array<string>,\n          /** Pricing in USD per million tokens. */\n          cost: Array<{\n              tier?: {\n                type: \"context\",\n                /** @integer */\n                size: number,\n              },\n              input: number,\n              output: number,\n              cache: {\n                read: number,\n                write: number,\n              },\n            }>,\n          status: \"alpha\" | \"beta\" | \"deprecated\" | \"active\",\n        }>,\n    }>,\n  /** Number of matching models across all pages. @integer */\n  total: number,\n  /** Offset of the next page, or null on the last page. */\n  next: number | null,\n}> // Search the models available to use. Use this to turn a model name the user mentions into an exact reference for a too..."},{"path":"opencode.read_mcp_resource","line":"  - tools.opencode.read_mcp_resource({\n  /** The server field of the discovered resource. */\n  server: string,\n  /** Exact resource URI from discovery, an expanded uriTemplate, or the user. */\n  uri: string,\n}): Promise<{\n  server: string,\n  uri: string,\n  contents: Array<{\n        type: \"text\",\n        uri: string,\n        text: string,\n        mimeType?: string,\n      } | {\n        type: \"blob\",\n        uri: string,\n        blob: string,\n        mimeType?: string,\n      }>,\n}> // Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or ..."},{"path":"opencode.session_move","line":"  - tools.opencode.session_move({\n  /** Omit to move the current session. @pattern ^ses */\n  sessionID?: string,\n  /** Destination directory, relative to the target session''s directory or absolute. Supports ~. @minLength 1 */\n  directory: string,\n}): Promise<{\n  /** @pattern ^ses */\n  sessionID: string,\n  directory: string,\n}> // Move a session to another directory, or omit sessionID to move the current session. The current session moves at the ..."},{"path":"opencode.session_rename","line":"  - tools.opencode.session_rename({\n  /** Omit to rename the current session. @pattern ^ses */\n  sessionID?: string,\n  /** New session title. @minLength 1 */\n  title: string,\n}): Promise<{\n  /** @pattern ^ses */\n  sessionID: string,\n  title: string,\n}> // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo..."},{"path":"opencode.worktree_create","line":"  - tools.opencode.worktree_create({\n  name: string,\n}): Promise<{\n  directory: string,\n}> // Create a named worktree. Returns its directory."},{"path":"opencode.worktree_list","line":"  - tools.opencode.worktree_list(): Promise<{\n  worktrees: Array<{\n      directory: string,\n      strategy?: string,\n    }>,\n}> // List a repository''s worktrees."},{"path":"opencode.worktree_remove","line":"  - tools.opencode.worktree_remove({\n  /** Absolute path of the worktree to remove. @minLength 1 */\n  directory: string,\n  /** Discard modified and untracked files. Only set this when the user has confirmed forced removal. */\n  force?: boolean,\n}): Promise<{\n  directory: string,\n  removed: boolean,\n}> // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove."}]}]}');
INSERT INTO instruction_blob VALUES('8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9','[{"id":"opencode","name":"OpenCode","description":"Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."},{"id":"report","name":"Report","description":"Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."}]');
INSERT INTO instruction_blob VALUES('7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02','"Fri Nov 13 2026"');
INSERT INTO instruction_blob VALUES('2a217bd8a41181b004ae00699595b0e7acb551421d2f9b085eb8ebb524f88f0b','"<env>\n  Working directory: @HOME@/proj\n  Workspace root folder: @HOME@/proj\n  Is directory a git repo: yes\n  Platform: darwin\n  Prefer @S@/opencode/tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>"');
INSERT INTO instruction_blob VALUES('878fb7aaa24a3708d92386a39e7aad998b03000668367a626d33bd8f24648bfa','"<env>\n  Working directory: @S@/Chats/c1\n  Workspace root folder: @S@/Chats/c1\n  Is directory a git repo: no\n  Platform: darwin\n  Prefer @S@/opencode/tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>"');
INSERT INTO instruction_blob VALUES('aac40875df333dfcf69d09785c9a1f44b4de0f6f8ee856a6e174e005cf87c538','"<env>\n  Working directory: @S@/opencode/data/opencode/worktree/@ROOT6@/feature one\n  Workspace root folder: @S@/opencode/data/opencode/worktree/@ROOT6@/feature one\n  Is directory a git repo: yes\n  Platform: darwin\n  Prefer @S@/opencode/tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>"');
CREATE TABLE `instruction_entry` (
          `session_id` text NOT NULL,
          `key` text NOT NULL,
          `value` text,
          `removed` integer DEFAULT false NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `instruction_entry_pk` PRIMARY KEY(`session_id`, `key`),
          CONSTRAINT `fk_instruction_entry_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `instruction_state` (
          `session_id` text PRIMARY KEY,
          `epoch_start` integer NOT NULL,
          `through_seq` integer NOT NULL,
          `initial_values` text NOT NULL,
          `current_values` text NOT NULL,
          CONSTRAINT `fk_instruction_state_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO instruction_state VALUES('ses_e2c1dd5f3ffeYix4zyU56M9is1',3,3,'{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"2a217bd8a41181b004ae00699595b0e7acb551421d2f9b085eb8ebb524f88f0b"}','{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"2a217bd8a41181b004ae00699595b0e7acb551421d2f9b085eb8ebb524f88f0b"}');
INSERT INTO instruction_state VALUES('ses_e2c1dc861ffeU6A6f6us8HLtRt',3,3,'{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"878fb7aaa24a3708d92386a39e7aad998b03000668367a626d33bd8f24648bfa"}','{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"878fb7aaa24a3708d92386a39e7aad998b03000668367a626d33bd8f24648bfa"}');
INSERT INTO instruction_state VALUES('ses_e2c1dac25ffenw3pfBTEa9Jzzl',0,0,'{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"878fb7aaa24a3708d92386a39e7aad998b03000668367a626d33bd8f24648bfa"}','{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"878fb7aaa24a3708d92386a39e7aad998b03000668367a626d33bd8f24648bfa"}');
INSERT INTO instruction_state VALUES('ses_e2c1dabd8ffeHQ4oqvqnwI5Ife',3,3,'{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"aac40875df333dfcf69d09785c9a1f44b4de0f6f8ee856a6e174e005cf87c538"}','{"core/codemode":"1f1291478accf8b3e4d96a40c150bf844d60557dede4aae56c47ea0043bbdce2","core/skill-guidance":"8394362d28c82fa4d13c7a9f5568c05680f6687e07db8f426a0e3c92f3027dc9","core/date":"7fa2430dbb35abe824e7ac98cb7a26aa273c984f082e8141681dc20cd413ef02","core/environment":"aac40875df333dfcf69d09785c9a1f44b4de0f6f8ee856a6e174e005cf87c538"}');
CREATE TABLE `session_inbox` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `payload` text NOT NULL,
          `delivery` text NOT NULL,
          `enqueued_seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          CONSTRAINT `fk_session_inbox_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_inbox VALUES('msg_1d3e247af001UHtNj5BzM8KmR6','ses_e2c1dc861ffeU6A6f6us8HLtRt','user','{"text":"see attached","files":[{"data":"UE5HREFUQQ==","mime":"text/plain","source":{"type":"uri","uri":"file://@S@/Attachments/ses_a/b.png"},"name":"b.png"},{"data":"UE5HREFUQQ==","mime":"text/plain","source":{"type":"uri","uri":"file://@S_URL@/Attachments/ses_a/b.png"},"name":"b enc.png"}]}','steer',31,1794556184497);
INSERT INTO session_inbox VALUES('msg_1d3e247bb001m74cTxx7iF60Em','ses_e2c1dc861ffeU6A6f6us8HLtRt','synthetic','{"text":"The following shell command was executed by the user:\n<shell id=\"sh_1d3e247b300103n7IaePGm40fy\" state=\"completed\" command=\"pwd\">\n@S@/Chats/c1\n\n</shell>","metadata":{"source":"shell","shellID":"sh_1d3e247b300103n7IaePGm40fy","state":"completed","truncated":false,"exit":0}}','steer',34,1794556184507);
INSERT INTO session_inbox VALUES('msg_1d3e253eb001bFCJLtxTbU442O','ses_e2c1dac23ffeO4w7O36uHI4BsC','user','{"text":"hello, no reply needed"}','steer',1,1794556187664);
INSERT INTO session_inbox VALUES('msg_1d3e2604c001omvAjw0FScHpaV','ses_e2c1dac23ffeO4w7O36uHI4BsC','user','{"text":"queued one","files":[{"data":"UE5HREFUQQ==","mime":"text/plain","source":{"type":"uri","uri":"file://@S_URL@/Attachments/ses_a/b.png"},"name":"q.png"}]}','queue',2,1794556190797);
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_message VALUES('msg_1d3e22b2f001Ma2issEf8k8DpM','ses_e2c1dd5f3ffeYix4zyU56M9is1','user',4,1794556177360,1794556177360,'{"time":{"created":1794556177360},"text":"In a.txt, replace the text ''line two'' with ''line 2'' using your edit tool. Do nothing else, then answer ''done''."}');
INSERT INTO session_message VALUES('msg_1d3e22bd2001tHYmUaIylLvCAW','ses_e2c1dd5f3ffeYix4zyU56M9is1','assistant',5,1794556177363,1794556178206,'{"time":{"created":1794556177363,"streamed":1794556178193,"completed":1794556178206},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user wants me to edit a.txt, replacing ''line two'' with ''line 2''. Let me first check the file exists and read it.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556177864,"completed":1794556178192}},{"type":"tool","id":"call-0e77144f-41f0-4bfc-a269-0964157e7f51","name":"read","executed":false,"state":{"status":"completed","input":{"path":"a.txt"},"content":[{"type":"text","text":"Read file a.txt, lines 1-2\n1: line one\n2: line two"}],"metadata":{"truncated":false}},"time":{"created":1794556178190,"ran":1794556178193,"completed":1794556178199}}],"snapshot":{"start":"da2310612e3cbe9ea45011418b30d130a4814633","end":"da2310612e3cbe9ea45011418b30d130a4814633","files":[]},"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":2538,"output":14,"reasoning":38,"cache":{"read":1856,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e22f200012KySIGdnEiCVns','ses_e2c1dd5f3ffeYix4zyU56M9is1','assistant',14,1794556178209,1794556178923,'{"time":{"created":1794556178209,"streamed":1794556178872,"completed":1794556178923},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Now I''ll edit it.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556178771,"completed":1794556178866}},{"type":"tool","id":"call-7cf64387-bb21-47ba-8379-4e04acf62929","name":"edit","executed":false,"state":{"status":"completed","input":{"newString":"line 2","oldString":"line two","path":"a.txt"},"content":[{"type":"text","text":"Edited a.txt (1 replacement)"}],"metadata":{"files":[{"file":"a.txt","patch":"Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n line one\n-line two\n+line 2\n","status":"modified","additions":1,"deletions":1}],"truncated":false}},"time":{"created":1794556178830,"ran":1794556178871,"completed":1794556178880}}],"snapshot":{"start":"da2310612e3cbe9ea45011418b30d130a4814633","end":"81d9b53475592385cb0f17131c3c7949cac87b15","files":["a.txt"]},"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":125,"output":36,"reasoning":9,"cache":{"read":4352,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e231ee0015zYv8cOpVhhsFz','ses_e2c1dd5f3ffeYix4zyU56M9is1','assistant',23,1794556178927,1794556179331,'{"time":{"created":1794556178927,"streamed":1794556179321,"completed":1794556179331},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Done.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556179295,"completed":1794556179320}},{"type":"text","text":"done"}],"snapshot":{"start":"81d9b53475592385cb0f17131c3c7949cac87b15","end":"81d9b53475592385cb0f17131c3c7949cac87b15","files":[]},"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":124,"output":5,"reasoning":8,"cache":{"read":4416,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e23384002CA0CLvvNvxoXvB','ses_e2c1dd5f3ffeYix4zyU56M9is1','idle',30,1794556179332,1794556179333,'{"time":{"created":1794556179332},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_1d3e237c7001bXwRfN7lxZasal','ses_e2c1dc861ffeU6A6f6us8HLtRt','user',4,1794556180467,1794556180467,'{"time":{"created":1794556180467},"text":"Create a file hello.txt in the current folder containing ''hi'', with your write tool. Then run the bash command `ls` once. Then answer ''done''."}');
INSERT INTO session_message VALUES('msg_1d3e237f4001qManlqckHwQFtm','ses_e2c1dc861ffeU6A6f6us8HLtRt','assistant',5,1794556180469,1794556181856,'{"time":{"created":1794556180469,"streamed":1794556181849,"completed":1794556181856},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user wants me to:\n1. Create a file hello.txt in the current folder containing ''hi'' using write tool\n2. Run bash command `ls` once\n3. Answer ''done''\n\nLet me do step 1 first, then step 2, then answer done. Actually I can do step 1 and 2 in parallel? The user says \"Then run the bash command `ls` once.\" which implies sequence. But they''re independent in terms of file creation and listing. Actually ls would show the file. Let me do write first, then ls. Actually to be safe and follow sequence, do write first, then ls. But could parallelize. The instruction says \"Then\" suggesting order. Let me just do write first.\n\nCurrent folder is @S@/Chats/c1. I''ll write hello.txt there.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556180967,"completed":1794556181843}},{"type":"tool","id":"call-ec0abc4f-a87c-4960-b525-f45feb66fae8","name":"write","executed":false,"state":{"status":"completed","input":{"content":"hi","path":"@S@/Chats/c1/hello.txt"},"content":[{"type":"text","text":"Created file successfully: hello.txt"}],"metadata":{"truncated":false}},"time":{"created":1794556181719,"ran":1794556181847,"completed":1794556181854}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":2560,"output":58,"reasoning":210,"cache":{"read":1856,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e23d66001nsecvfWSmO78RE','ses_e2c1dc861ffeU6A6f6us8HLtRt','assistant',14,1794556181867,1794556183503,'{"time":{"created":1794556181867,"streamed":1794556182655,"completed":1794556183502},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Now run ls.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556182580,"completed":1794556182654}},{"type":"tool","id":"call-76db76c4-c1ae-44b5-8c54-0ba4a5414645","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"ls"},"content":[{"type":"text","text":"hello.txt\nnotes.md\n"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1794556182653,"ran":1794556182655,"completed":1794556183500}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":285,"output":12,"reasoning":13,"cache":{"read":4416,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e243d4001dDV19F43fCROhq','ses_e2c1dc861ffeU6A6f6us8HLtRt','assistant',23,1794556183511,1794556184032,'{"time":{"created":1794556183511,"streamed":1794556184031,"completed":1794556184032},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Done.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556184009,"completed":1794556184027}},{"type":"text","text":"done"}],"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":71,"output":5,"reasoning":8,"cache":{"read":4672,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e245e30016lADErqSuHHCjQ','ses_e2c1dc861ffeU6A6f6us8HLtRt','idle',30,1794556184035,1794556184035,'{"time":{"created":1794556184035},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_1d3e247b5002kcI62wrbS2KBag','ses_e2c1dc861ffeU6A6f6us8HLtRt','shell',32,1794556184501,1794556184506,'{"metadata":{"background":true},"time":{"created":1794556184501,"completed":1794556184505},"shellID":"sh_1d3e247b300103n7IaePGm40fy","command":"pwd","status":"exited","exit":0,"output":{"output":"@S@/Chats/c1\n","cursor":108,"size":108,"truncated":false}}');
INSERT INTO session_message VALUES('msg_1d3e253db001l2vHIesp9pN7zf_4','ses_e2c1dac25ffenw3pfBTEa9Jzzl','user',4,1794556180467,1794556180467,'{"time":{"created":1794556180467},"text":"Create a file hello.txt in the current folder containing ''hi'', with your write tool. Then run the bash command `ls` once. Then answer ''done''."}');
INSERT INTO session_message VALUES('msg_1d3e253db001l2vHIesp9pN7zf_5','ses_e2c1dac25ffenw3pfBTEa9Jzzl','assistant',5,1794556180469,1794556181856,'{"time":{"created":1794556180469,"streamed":1794556181849,"completed":1794556181856},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user wants me to:\n1. Create a file hello.txt in the current folder containing ''hi'' using write tool\n2. Run bash command `ls` once\n3. Answer ''done''\n\nLet me do step 1 first, then step 2, then answer done. Actually I can do step 1 and 2 in parallel? The user says \"Then run the bash command `ls` once.\" which implies sequence. But they''re independent in terms of file creation and listing. Actually ls would show the file. Let me do write first, then ls. Actually to be safe and follow sequence, do write first, then ls. But could parallelize. The instruction says \"Then\" suggesting order. Let me just do write first.\n\nCurrent folder is @S@/Chats/c1. I''ll write hello.txt there.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556180967,"completed":1794556181843}},{"type":"tool","id":"call-ec0abc4f-a87c-4960-b525-f45feb66fae8","name":"write","executed":false,"state":{"status":"completed","input":{"content":"hi","path":"@S@/Chats/c1/hello.txt"},"content":[{"type":"text","text":"Created file successfully: hello.txt"}],"metadata":{"truncated":false}},"time":{"created":1794556181719,"ran":1794556181847,"completed":1794556181854}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":2560,"output":58,"reasoning":210,"cache":{"read":1856,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e253db001l2vHIesp9pN7zf_14','ses_e2c1dac25ffenw3pfBTEa9Jzzl','assistant',14,1794556181867,1794556183503,'{"time":{"created":1794556181867,"streamed":1794556182655,"completed":1794556183502},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Now run ls.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556182580,"completed":1794556182654}},{"type":"tool","id":"call-76db76c4-c1ae-44b5-8c54-0ba4a5414645","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"ls"},"content":[{"type":"text","text":"hello.txt\nnotes.md\n"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1794556182653,"ran":1794556182655,"completed":1794556183500}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":285,"output":12,"reasoning":13,"cache":{"read":4416,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e253db001l2vHIesp9pN7zf_23','ses_e2c1dac25ffenw3pfBTEa9Jzzl','assistant',23,1794556183511,1794556184032,'{"time":{"created":1794556183511,"streamed":1794556184031,"completed":1794556184032},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Done.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556184009,"completed":1794556184027}},{"type":"text","text":"done"}],"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":71,"output":5,"reasoning":8,"cache":{"read":4672,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e253db001l2vHIesp9pN7zf_30','ses_e2c1dac25ffenw3pfBTEa9Jzzl','idle',30,1794556184035,1794556184035,'{"time":{"created":1794556184035},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_1d3e253db001l2vHIesp9pN7zf_32','ses_e2c1dac25ffenw3pfBTEa9Jzzl','shell',32,1794556184501,1794556184506,'{"metadata":{"background":true},"time":{"created":1794556184501,"completed":1794556184505},"shellID":"sh_1d3e247b300103n7IaePGm40fy","command":"pwd","status":"exited","exit":0,"output":{"output":"@S@/Chats/c1\n","cursor":108,"size":108,"truncated":false}}');
INSERT INTO session_message VALUES('msg_1d3e25445001G5FS7elGZ8f7vQ','ses_e2c1dabd8ffeHQ4oqvqnwI5Ife','user',4,1794556187771,1794556187771,'{"time":{"created":1794556187771},"text":"Append a line ''three'' to a.txt using your edit tool, then answer ''done''."}');
INSERT INTO session_message VALUES('msg_1d3e2547b002GFT2eI5lKY57kZ','ses_e2c1dabd8ffeHQ4oqvqnwI5Ife','assistant',5,1794556187772,1794556189079,'{"time":{"created":1794556187772,"streamed":1794556189055,"completed":1794556189077},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user wants me to append a line ''three'' to a.txt using the edit tool, then answer ''done''. Let me first read the file to understand its current content.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556188774,"completed":1794556189049}},{"type":"tool","id":"call-4d07c8bb-a355-4a1e-9d00-17146aad342d","name":"read","executed":false,"state":{"status":"completed","input":{"path":"a.txt"},"content":[{"type":"text","text":"Read file a.txt, lines 1-2\n1: line one\n2: line two"}],"metadata":{"truncated":false}},"time":{"created":1794556189008,"ran":1794556189054,"completed":1794556189060}}],"snapshot":{"start":"da2310612e3cbe9ea45011418b30d130a4814633","end":"da2310612e3cbe9ea45011418b30d130a4814633","files":[]},"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":2570,"output":14,"reasoning":43,"cache":{"read":1856,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e2599c001y4S0z0iw3dypuY','ses_e2c1dabd8ffeHQ4oqvqnwI5Ife','assistant',14,1794556189087,1794556190122,'{"time":{"created":1794556189087,"streamed":1794556190061,"completed":1794556190121},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The file has two lines: \"line one\" and \"line two\". I need to append \"three\" as a new line. The file content ends with \"line two\" (no trailing newline shown, but let me check). Actually the read shows line 2 \"line two\". I should edit to add \"three\" on a new line. Let me append by replacing \"line two\" with \"line two\\nthree\".","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556189569,"completed":1794556190054}},{"type":"tool","id":"call-4c670ea2-07ee-4cc5-acc9-691ee3b9dff0","name":"edit","executed":false,"state":{"status":"completed","input":{"newString":"line one\nline two\nthree","oldString":"line one\nline two","path":"a.txt"},"content":[{"type":"text","text":"Edited a.txt (1 replacement)"}],"metadata":{"files":[{"file":"a.txt","patch":"Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,2 +1,3 @@\n line one\n line two\n+three\n","status":"modified","additions":1,"deletions":0}],"truncated":false}},"time":{"created":1794556189924,"ran":1794556190059,"completed":1794556190067}}],"snapshot":{"start":"da2310612e3cbe9ea45011418b30d130a4814633","end":"9ec926bc939d5d1931836a8fe0363c385cfd347d","files":["a.txt"]},"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":2658,"output":38,"reasoning":95,"cache":{"read":1856,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e25dad001p11PsA1H62Ucgy','ses_e2c1dabd8ffeHQ4oqvqnwI5Ife','assistant',23,1794556190126,1794556190585,'{"time":{"created":1794556190126,"streamed":1794556190566,"completed":1794556190584},"agent":"build","model":{"id":"beam-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Done. Now answer ''done''.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794556190531,"completed":1794556190562}},{"type":"text","text":"done"}],"snapshot":{"start":"9ec926bc939d5d1931836a8fe0363c385cfd347d","end":"9ec926bc939d5d1931836a8fe0363c385cfd347d","files":[]},"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":185,"output":5,"reasoning":13,"cache":{"read":4480,"write":0}}}');
INSERT INTO session_message VALUES('msg_1d3e25f7b001Dcz46qbnwLY2GP','ses_e2c1dabd8ffeHQ4oqvqnwI5Ife','idle',30,1794556190587,1794556190587,'{"time":{"created":1794556190587},"outcome":"succeeded"}');
CREATE TABLE `session_part` (
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `ordinal` integer NOT NULL,
          `type` text NOT NULL,
          `call_id` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `session_part_pk` PRIMARY KEY(`message_id`, `ordinal`),
          CONSTRAINT `fk_session_part_message_id_session_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `session_message`(`id`) ON DELETE CASCADE,
          CONSTRAINT `fk_session_part_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_v2` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `fork_session_id` text,
          `fork_boundary` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_busy` integer,
          `time_idle` integer,
          `time_viewed` integer,
          `idle_outcome` text,
          `time_compacting` integer,
          `time_archived` integer,
          `time_suspended` integer,
          `resume_attempts` integer DEFAULT 0 NOT NULL,
          CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_v2 VALUES('ses_e2c1dd5f3ffeYix4zyU56M9is1','@ROOT@',NULL,NULL,NULL,NULL,'clever-canyon','@HOME@/proj','','git edit','2.2.6',NULL,NULL,NULL,NULL,NULL,NULL,0.0,2787,55,55,10624,0,'{"messageID":"msg_1d3e22b2f001Ma2issEf8k8DpM","snapshot":"81d9b53475592385cb0f17131c3c7949cac87b15","files":[{"file":"a.txt","status":"modified","additions":1,"deletions":1,"patch":"diff --git a/a.txt b/a.txt\nindex f903b0d..e5c5c55 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n line one\n-line 2\n+line two\n"}]}',NULL,NULL,'{"id":"beam-free","providerID":"opencode"}',1794556176923,1794556187609,1794556177357,1794556179332,NULL,'succeeded',NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_e2c1dc861ffeU6A6f6us8HLtRt','@ID:@S@/Chats/c1@',NULL,NULL,NULL,NULL,'shiny-otter','@S@/Chats/c1','','chat','2.2.6',NULL,NULL,NULL,NULL,NULL,NULL,0.0,2916,75,231,10944,0,NULL,NULL,NULL,'{"id":"beam-free","providerID":"opencode"}',1794556180387,1794556184507,1794556180465,1794556184035,NULL,'succeeded',NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_e2c1dac25ffenw3pfBTEa9Jzzl','@ID:@S@/Chats/c1@',NULL,NULL,'ses_e2c1dc861ffeU6A6f6us8HLtRt','{"type":"through","messageID":"msg_1d3e247b5002kcI62wrbS2KBag"}','silent-canyon','@S@/Chats/c1','','chat (fork #1)','2.2.6',NULL,NULL,NULL,NULL,NULL,NULL,0.0,0,0,0,0,0,NULL,NULL,NULL,'{"id":"beam-free","providerID":"opencode"}',1794556187611,1794556187611,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_e2c1dac23ffeO4w7O36uHI4BsC','@ID:@HOME@/Projects/plain@',NULL,NULL,NULL,NULL,'quiet-pixel','@HOME@/Projects/plain','','plain','2.2.6',NULL,NULL,NULL,NULL,NULL,NULL,0.0,0,0,0,0,0,NULL,NULL,NULL,'{"id":"beam-free","providerID":"opencode"}',1794556187613,1794556190797,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0);
INSERT INTO session_v2 VALUES('ses_e2c1dabd8ffeHQ4oqvqnwI5Ife','@ROOT@',NULL,NULL,NULL,NULL,'eager-lagoon','@S@/opencode/data/opencode/worktree/@ROOT6@/feature one','','in worktree','2.2.6',NULL,NULL,NULL,NULL,NULL,NULL,0.0,5413,57,151,8192,0,NULL,NULL,NULL,'{"id":"beam-free","providerID":"opencode"}',1794556187702,1794556190584,1794556187768,1794556190587,NULL,'succeeded',NULL,NULL,NULL,0);
CREATE TABLE `workspace` (
          `id` text PRIMARY KEY,
          `provider` text NOT NULL,
          `binding` text,
          `created_at` integer NOT NULL,
          `last_used_at` integer NOT NULL
        );
CREATE TABLE `worktree` (
          `project_id` text NOT NULL,
          `directory` text NOT NULL,
          `strategy` text,
          `time_created` integer NOT NULL,
          CONSTRAINT `worktree_pk` PRIMARY KEY(`project_id`, `directory`),
          CONSTRAINT `fk_worktree_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO worktree VALUES('@ROOT@','@HOME@/proj',NULL,1794556176923);
INSERT INTO worktree VALUES('@ROOT@','@S@/opencode/data/opencode/worktree/@ROOT6@/feature one','git',1794556187686);
CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration VALUES('20260127222353_familiar_lady_ursula',1794556176891);
INSERT INTO migration VALUES('20260211171708_add_project_commands',1794556176891);
INSERT INTO migration VALUES('20260213144116_wakeful_the_professor',1794556176891);
INSERT INTO migration VALUES('20260225215848_workspace',1794556176891);
INSERT INTO migration VALUES('20260227213759_add_session_workspace_id',1794556176891);
INSERT INTO migration VALUES('20260228203230_blue_harpoon',1794556176891);
INSERT INTO migration VALUES('20260303231226_add_workspace_fields',1794556176891);
INSERT INTO migration VALUES('20260309230000_move_org_to_state',1794556176891);
INSERT INTO migration VALUES('20260312043431_session_message_cursor',1794556176891);
INSERT INTO migration VALUES('20260323234822_events',1794556176891);
INSERT INTO migration VALUES('20260410174513_workspace-name',1794556176891);
INSERT INTO migration VALUES('20260413175956_chief_energizer',1794556176891);
INSERT INTO migration VALUES('20260423070820_add_icon_url_override',1794556176891);
INSERT INTO migration VALUES('20260427172553_slow_nightmare',1794556176891);
INSERT INTO migration VALUES('20260428004200_add_session_path',1794556176891);
INSERT INTO migration VALUES('20260501142318_next_venus',1794556176891);
INSERT INTO migration VALUES('20260504145000_add_sync_owner',1794556176891);
INSERT INTO migration VALUES('20260507164347_add_workspace_time',1794556176891);
INSERT INTO migration VALUES('20260510033149_session_usage',1794556176891);
INSERT INTO migration VALUES('20260511000411_data_migration_state',1794556176891);
INSERT INTO migration VALUES('20260511173437_session-metadata',1794556176891);
INSERT INTO migration VALUES('20260601010001_normalize_storage_paths',1794556176891);
INSERT INTO migration VALUES('20260601202201_amazing_prowler',1794556176891);
INSERT INTO migration VALUES('20260602002951_lowly_union_jack',1794556176891);
INSERT INTO migration VALUES('20260602182828_add_project_directories',1794556176891);
INSERT INTO migration VALUES('20260603001617_session_message_projection_indexes',1794556176891);
INSERT INTO migration VALUES('20260603040000_session_message_projection_order',1794556176891);
INSERT INTO migration VALUES('20260603141458_session_input_inbox',1794556176891);
INSERT INTO migration VALUES('20260603160727_jittery_ezekiel_stane',1794556176891);
INSERT INTO migration VALUES('20260604172448_event_sourced_session_input',1794556176891);
INSERT INTO migration VALUES('20260605003541_add_session_context_snapshot',1794556176891);
INSERT INTO migration VALUES('20260605042240_add_context_epoch_agent',1794556176891);
INSERT INTO migration VALUES('20260611035744_credential',1794556176891);
INSERT INTO migration VALUES('20260611192811_lush_chimera',1794556176891);
INSERT INTO migration VALUES('20260612174303_project_dir_strategy',1794556176891);
INSERT INTO migration VALUES('20260622142730_simplify_session_context_epoch',1794556176891);
INSERT INTO migration VALUES('20260622170816_reset_v2_session_state',1794556176891);
INSERT INTO migration VALUES('20260622202450_simplify_session_input',1794556176891);
INSERT INTO migration VALUES('20260804233008_loose_psylocke',1794556176892);
INSERT INTO migration VALUES('20260805200742_import_legacy_credentials',1794556176892);
INSERT INTO migration VALUES('20260808023530_workspace_domain',1794556176892);
INSERT INTO migration VALUES('20260811161259_execution_claim_attempts',1794556176892);
INSERT INTO migration VALUES('20260812181746_session_inbox',1794556176892);
INSERT INTO migration VALUES('20260812213948_worktree',1794556176892);
INSERT INTO migration VALUES('20260819222447_session_viewed_state',1794556176892);
INSERT INTO migration VALUES('20260823191254_nullable_workspace_binding',1794556176892);
INSERT INTO migration VALUES('20260910120000_clear_v1_session_permission',1794556176892);
INSERT INTO migration VALUES('20260923013825_project_time_active',1794556176892);
INSERT INTO migration VALUES('20261007190000_azure_cli_external_credential',1794556176892);
INSERT INTO migration VALUES('20261010180456_project_time_archived',1794556176892);
INSERT INTO migration VALUES('20261024002554_session_allowance',1794556176892);
INSERT INTO migration VALUES('20261024175301_drop_session_allowance',1794556176892);
INSERT INTO migration VALUES('20261025123711_blob',1794556176892);
INSERT INTO migration VALUES('20261025154125_drop_session_pending',1794556176892);
INSERT INTO migration VALUES('20261026223005_schedule',1794556176892);
INSERT INTO migration VALUES('20261029002625_session_part',1794556176892);
INSERT INTO migration VALUES('20261029073502_session_time_busy',1794556176892);
INSERT INTO migration VALUES('20261029165540_schedule_checks',1794556176892);
INSERT INTO migration VALUES('20261030054400_job',1794556176892);
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);
CREATE INDEX `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`);
CREATE INDEX `job_session_idx` ON `job` (`session_id`);
CREATE INDEX `job_child_session_idx` ON `job` (`child_session_id`);
CREATE INDEX `job_id_idx` ON `job` (`id`);
CREATE UNIQUE INDEX `permission_project_action_resource_idx` ON `permission` (`project_id`,`action`,`resource`);
CREATE INDEX `schedule_session_idx` ON `schedule` (`session_id`);
CREATE INDEX `schedule_due_idx` ON `schedule` (`next_due_at`) WHERE "schedule"."status" = 'active' and "schedule"."next_due_at" is not null;
CREATE INDEX `blob_ref_hash_idx` ON `blob_ref` (`hash`);
CREATE INDEX `blob_ref_session_seq_idx` ON `blob_ref` (`session_id`,`seq`);
CREATE INDEX `session_inbox_session_delivery_seq_idx` ON `session_inbox` (`session_id`,`delivery`,`enqueued_seq`);
CREATE UNIQUE INDEX `session_inbox_session_enqueued_seq_idx` ON `session_inbox` (`session_id`,`enqueued_seq`);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
CREATE INDEX `session_part_session_message_idx` ON `session_part` (`session_id`,`message_id`,`ordinal`);
CREATE INDEX `session_v2_project_idx` ON `session_v2` (`project_id`);
CREATE INDEX `session_v2_workspace_idx` ON `session_v2` (`workspace_id`);
CREATE INDEX `session_v2_parent_idx` ON `session_v2` (`parent_id`);
CREATE INDEX `session_v2_time_suspended_idx` ON `session_v2` (`time_suspended`) WHERE "session_v2"."time_suspended" is not null;
COMMIT;
