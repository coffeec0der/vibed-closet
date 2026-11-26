import {
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  type Ref,
} from '@mikro-orm/core';
import { User } from './user.entity';

export type TryOnJobStatus = 'queued' | 'running' | 'done' | 'failed';

/** One garment rendered onto the person, in order. */
export interface TryOnPass {
  garmentId: number;
  category: 'upper' | 'lower' | 'overall';
}

/**
 * A virtual try-on request: a person photo plus one or more garments that are
 * rendered on top of each other, one pass per garment.
 */
@Entity()
@Index({ properties: ['status'] })
export class TryOnJob {
  @PrimaryKey()
  public id!: number;

  @Property()
  public status: TryOnJobStatus = 'queued';

  /** Stored file name of the person photo. */
  @Property()
  public personFile!: string;

  @Property({ type: 'json' })
  public passes!: TryOnPass[];

  /** Outfit the request came from, if any (informational). */
  @Property({ nullable: true })
  public outfitId?: number;

  @Property({ nullable: true })
  public label?: string;

  /** Stored file name of the rendered result. */
  @Property({ nullable: true })
  public resultFile?: string;

  /** Where it rendered: 'local' or 'remote'. */
  @Property({ nullable: true })
  public renderer?: string;

  /** Human-readable progress, e.g. "Pass 1/2 · step 12/30". */
  @Property({ nullable: true })
  public progress?: string;

  @Property({ nullable: true, columnType: 'text' })
  public error?: string;

  @Property()
  public createdAt: Date = new Date();

  @Property({ nullable: true })
  public startedAt?: Date;

  @Property({ nullable: true })
  public finishedAt?: Date;

  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
    nullable: true,
  })
  public owner?: Ref<User>;
}
