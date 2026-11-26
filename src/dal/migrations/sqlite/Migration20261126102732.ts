import { Migration } from '@mikro-orm/migrations';

export class Migration20261126102732 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table \`garment\` add column \`price\` double null;`);
    this.addSql(`alter table \`garment\` add column \`tags\` text null;`);
    this.addSql(`alter table \`garment\` add column \`in_laundry\` integer not null default false;`);
  }

}
