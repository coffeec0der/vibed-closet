import { Migration } from '@mikro-orm/migrations';

export class Migration20261126165509 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table \`try_on_job\` (\`id\` integer not null primary key autoincrement, \`status\` text not null default 'queued', \`person_file\` text not null, \`passes\` json not null, \`outfit_id\` integer null, \`label\` text null, \`result_file\` text null, \`renderer\` text null, \`progress\` text null, \`error\` text null, \`created_at\` datetime not null, \`started_at\` datetime null, \`finished_at\` datetime null, \`owner_id\` integer null, constraint \`try_on_job_owner_id_foreign\` foreign key(\`owner_id\`) references \`user\`(\`id\`) on delete cascade on update cascade);`);
    this.addSql(`create index \`try_on_job_owner_id_index\` on \`try_on_job\` (\`owner_id\`);`);
    this.addSql(`create index \`try_on_job_status_index\` on \`try_on_job\` (\`status\`);`);
  }

}
