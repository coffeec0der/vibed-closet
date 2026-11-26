import { Migration } from '@mikro-orm/migrations';

export class Migration20261126102722 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "garment" add column "price" double precision null, add column "tags" text null, add column "in_laundry" boolean not null default false;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "garment" drop column "price", drop column "tags", drop column "in_laundry";`);
  }

}
