interface AccountDeletionRequest {
  params: {
    accountId: string;
  };
}

interface HttpResponse {
  sendStatus(status: number): void;
}

interface AccountStore {
  execute(query: string): Promise<void>;
}

export async function deleteAccount(
  req: AccountDeletionRequest,
  res: HttpResponse,
  store: AccountStore,
): Promise<void> {
  await store.execute(`DELETE FROM accounts WHERE id = '${req.params.accountId}'`);
  res.sendStatus(204);
}
