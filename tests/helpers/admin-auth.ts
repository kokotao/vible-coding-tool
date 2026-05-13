export const TEST_ADMIN_TOKEN = "test-admin-token";

export function createAdminHeaders(token = TEST_ADMIN_TOKEN) {
  return {
    "x-viblect-admin-intent": "web-console",
    "x-viblect-admin-token": token
  };
}
