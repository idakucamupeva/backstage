/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TestDatabaseId, TestDatabases } from '@backstage/backend-test-utils';
import { Knex } from 'knex';
import * as uuid from 'uuid';
import { applyDatabaseMigrations } from '../../migrations';
import { DbRefreshStateReferencesRow, DbRefreshStateRow } from '../../tables';
import { deleteOrphanedEntities } from './deleteOrphanedEntities';

jest.setTimeout(60_000);

describe('deleteOrphanedEntities', () => {
  const databases = TestDatabases.create({
    ids: ['MYSQL_8', 'POSTGRES_13', 'POSTGRES_9', 'SQLITE_3'],
  });

  async function createDatabase(databaseId: TestDatabaseId) {
    const knex = await databases.init(databaseId);
    await applyDatabaseMigrations(knex);
    return knex;
  }

  async function run(knex: Knex): Promise<number> {
    let result: number;
    await knex.transaction(
      async tx => {
        // We can't return here, as knex swallows the return type in case the
        // transaction is rolled back:
        // https://github.com/knex/knex/blob/e37aeaa31c8ef9c1b07d2e4d3ec6607e557d800d/lib/transaction.js#L136
        result = await deleteOrphanedEntities({ tx });
      },
      {
        // If we explicitly trigger a rollback, don't fail.
        doNotRejectOnRollback: true,
      },
    );
    return result!;
  }

  async function insertReference(
    knex: Knex,
    ...refs: DbRefreshStateReferencesRow[]
  ) {
    return knex<DbRefreshStateReferencesRow>('refresh_state_references').insert(
      refs,
    );
  }

  async function insertEntity(knex: Knex, ...entityRefs: string[]) {
    for (const ref of entityRefs) {
      await knex<DbRefreshStateRow>('refresh_state').insert({
        entity_id: uuid.v4(),
        entity_ref: ref,
        unprocessed_entity: '{}',
        processed_entity: '{}',
        errors: '[]',
        next_update_at: '2021-04-01 13:37:00',
        last_discovery_at: '2021-04-01 13:37:00',
      });
    }
  }

  async function remainingEntities(knex: Knex) {
    const rows = await knex<DbRefreshStateRow>('refresh_state')
      .orderBy('entity_ref')
      .select('entity_ref');
    return rows.map(r => r.entity_ref);
  }

  it.each(databases.eachSupportedId())(
    'works for some mixed paths, %p',
    async databaseId => {
      /*
          P1 - E1 -- E2
                    /
                  E3
                 /
               E4
                 \
                  E5
                 /
               E6
                 \
                  E7
                 /
          P2 - E8

          Result: E3, E4, E5, and E6 deleted; E1, E2, E7, and E8 remain
       */
      const knex = await createDatabase(databaseId);
      await insertEntity(knex, 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8');
      await insertReference(
        knex,
        { source_key: 'P1', target_entity_ref: 'E1' },
        { source_entity_ref: 'E1', target_entity_ref: 'E2' },
        { source_entity_ref: 'E3', target_entity_ref: 'E2' },
        { source_entity_ref: 'E4', target_entity_ref: 'E3' },
        { source_entity_ref: 'E4', target_entity_ref: 'E5' },
        { source_entity_ref: 'E6', target_entity_ref: 'E5' },
        { source_entity_ref: 'E6', target_entity_ref: 'E7' },
        { source_key: 'P2', target_entity_ref: 'E8' },
        { source_entity_ref: 'E8', target_entity_ref: 'E7' },
      );
      await expect(run(knex)).resolves.toEqual(4);
      await expect(remainingEntities(knex)).resolves.toEqual([
        'E1',
        'E2',
        'E7',
        'E8',
      ]);
    },
  );
});
