import { Migration } from '@mikro-orm/migrations';

export class Migration20261126165506 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "try_on_job" ("id" serial primary key, "status" varchar(255) not null default 'queued', "person_file" varchar(255) not null, "passes" jsonb not null, "outfit_id" int null, "label" varchar(255) null, "result_file" varchar(255) null, "renderer" varchar(255) null, "progress" varchar(255) null, "error" text null, "created_at" timestamptz not null, "started_at" timestamptz null, "finished_at" timestamptz null, "owner_id" int null);`);
    this.addSql(`create index "try_on_job_status_index" on "try_on_job" ("status");`);

    this.addSql(`alter table "try_on_job" add constraint "try_on_job_owner_id_foreign" foreign key ("owner_id") references "user" ("id") on update cascade on delete cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "try_on_job" cascade;`);
  }

}
