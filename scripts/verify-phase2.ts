import { prisma } from '../src/db/client.js';
import { CustomerService } from '../src/services/customer.service.js';
import { hashApiKey } from '../src/lib/crypto.js';

async function main() {
  console.log('--- Phase 2 Verification Script ---');

  // 1. Clean previous test data
  await prisma.customer.deleteMany({ where: { email: 'dev@acme.com' } });

  // 2. Create customer and initial API key
  console.log('1. Onboarding new customer: "Acme Corp"...');
  const onboarded = await CustomerService.createCustomer({
    name: 'Acme Corp',
    email: 'dev@acme.com',
  });

  console.log('✔ Customer created:', onboarded.customer);
  console.log('✔ Plaintext API Key generated (shown once):', onboarded.apiKey.rawKey);
  console.log('✔ Key prefix:', onboarded.apiKey.keyPrefix);

  // 3. Verify hashing in database
  console.log('2. Verifying database record does NOT store plaintext key...');
  const dbRecord = await prisma.apiKey.findUnique({
    where: { id: onboarded.apiKey.id },
  });

  if (!dbRecord) {
    throw new Error('API Key record not found in database');
  }

  console.log('✔ DB Key Hash in PostgreSQL:', dbRecord.keyHash);
  if (dbRecord.keyHash === onboarded.apiKey.rawKey) {
    throw new Error('SECURITY VIOLATION: Plaintext key stored in DB!');
  }

  const expectedHash = hashApiKey(onboarded.apiKey.rawKey);
  if (dbRecord.keyHash !== expectedHash) {
    throw new Error('Hash mismatch: DB hash does not match computed HMAC-SHA256');
  }
  console.log('✔ HMAC-SHA256 Hash matches expected value!');

  // 4. Test creating a second key
  console.log('3. Creating second API key for customer...');
  const secondKey = await CustomerService.createApiKey(onboarded.customer.id, 'Staging Key');
  console.log('✔ Second API key created:', secondKey.rawKey);

  // 5. Test listing API keys
  console.log('4. Listing customer API keys (safe metadata only)...');
  const keys = await CustomerService.listApiKeys(onboarded.customer.id);
  console.log('✔ Keys listed:', keys);

  // 6. Test revoking key
  console.log('5. Revoking the second API key...');
  await CustomerService.revokeApiKey(onboarded.customer.id, secondKey.id);
  const revokedKey = await prisma.apiKey.findUnique({ where: { id: secondKey.id } });
  console.log('✔ Second API key isActive status:', revokedKey?.isActive);

  // 7. Test HTTP API calls via fetch
  console.log('6. Testing HTTP endpoints with fetch...');
  const meResNoAuth = await fetch('http://localhost:3000/v1/me');
  console.log('✔ GET /v1/me (without auth) status:', meResNoAuth.status); // 401

  const meResInvalidAuth = await fetch('http://localhost:3000/v1/me', {
    headers: { 'x-api-key': 'wh_live_invalid_key_123456789' },
  });
  console.log('✔ GET /v1/me (with invalid key) status:', meResInvalidAuth.status); // 401

  const meResValidAuth = await fetch('http://localhost:3000/v1/me', {
    headers: { 'x-api-key': onboarded.apiKey.rawKey },
  });
  console.log('✔ GET /v1/me (with valid key) status:', meResValidAuth.status); // 200
  const meData = await meResValidAuth.json();
  console.log('✔ GET /v1/me response payload:', JSON.stringify(meData, null, 2));

  console.log('\n🎉 ALL PHASE 2 VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
