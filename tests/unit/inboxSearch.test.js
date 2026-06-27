import { performAdvancedSearch, performMessageSearch } from '../../src/services/inboxSearch.mjs';
import { Message, Customer } from '../../src/schemas/mongodb.mjs';

jest.mock('../../src/schemas/mongodb.mjs', () => ({
  Message: {
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
    find: jest.fn(),
  },
  Customer: {
    find: jest.fn(),
  },
}));

describe('inboxSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('performAdvancedSearch groups contacts from Mongo aggregation', async () => {
    Message.aggregate.mockResolvedValue([
      { _id: '+15551111111', last_message_ts: 200, message_count: 3 },
    ]);

    const rows = await performAdvancedSearch('user-1', { q: 'hello' });
    expect(Message.aggregate).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      { contact: '+15551111111', last_message_ts: 200, message_count: 3 },
    ]);
  });

  test('performMessageSearch returns paginated messages with customer names', async () => {
    Message.countDocuments.mockResolvedValue(1);
    Message.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([
              {
                id: 'm1',
                direction: 'inbound',
                type: 'text',
                text_body: 'hello',
                timestamp: 100,
                from_digits: '15551111111',
                from_id: '+15551111111',
                raw: {},
              },
            ]),
          }),
        }),
      }),
    });
    Customer.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { contact_id: '+15551111111', display_name: 'Jane' },
        ]),
      }),
    });

    const result = await performMessageSearch('user-1', { q: 'hello', limit: 10, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.messages[0].contact_name).toBe('Jane');
    expect(result.hasMore).toBe(false);
  });
});
