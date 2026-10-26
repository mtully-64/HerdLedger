// Shared test data and setup functions used by both test files

// Fixtures are setup code that gets run before the tests, so each test starts from a known state

// Ethers.js integration from Hardhat
const { ethers } = require("hardhat");

///////////////////////////////////////////////
// Shared constants
///////////////////////////////////////////////

// The role ids, ethers.id hashes the string with keccak256, the same way the contract builds its role constants so they match
const ROLES = {
  FARMER: ethers.id("FARMER_ROLE"),
  VET: ethers.id("VET_ROLE"),
  PROCESSOR: ethers.id("PROCESSOR_ROLE"),
};
// These three copy the enums in the contracts, the numbers have to match the order the enums are written in
const Sex = { Female: 0, Male: 1 };
const Status = { Alive: 0, Deceased: 1, Slaughtered: 2 };
const RecordType = { Vaccination: 0, Treatment: 1, Test: 2, Inspection: 3 };
// Seconds in a day, the blockchain measures time in seconds
const DAY = 24 * 60 * 60;

///////////////////////////////////////////////
// Setup functions
///////////////////////////////////////////////

// Deploys both contracts, connects them together and gives everyone their roles
async function deployFixture() {
  // Hardhat gives us fake test accounts, these are named in order, the first one is the deployer so it becomes the admin
  const [admin, farmerA, farmerB, vet, processor, stranger] = await ethers.getSigners();

  // The registry needs the admin address, then HealthRecords needs the registry's address
  const registry = await (await ethers.getContractFactory("CattleRegistry")).deploy(admin.address);
  const health = await (await ethers.getContractFactory("HealthRecords")).deploy(await registry.getAddress());
  // Tells the registry which contract to ask about restrictions and withdrawal periods
  await registry.setGuard(await health.getAddress());

  // Admin hands out the roles, the stranger gets none on purpose so we can test what happens to people without a role
  await registry.grantRole(ROLES.FARMER, farmerA.address);
  await registry.grantRole(ROLES.FARMER, farmerB.address);
  await registry.grantRole(ROLES.VET, vet.address);
  await registry.grantRole(ROLES.PROCESSOR, processor.address);

  // Everything goes back in one object so each test can pick out just the bits it needs
  return { registry, health, admin, farmerA, farmerB, vet, processor, stranger };
}

// Same as deployFixture but with one animal already registered, so tests don't have to repeat that step
async function withAnimalFixture() {
  const ctx = await deployFixture();
  // Uses the time on the blockchain, not the real clock, because the two can be different
  // 400 days ago so the birth date is safely in the past
  const birth = (await ethers.provider.getBlock("latest")).timestamp - 400 * DAY;
  // farmerA registers the animal so they are the owner, it gets id 1
  await ctx.registry.connect(ctx.farmerA).registerAnimal("IE123456780001", "Hereford", Sex.Female, birth, "Herd IE1234567, Louth");
  // The three dots copy everything from deployFixture into the new object, then animalId and birth are added on top
  // The n makes 1 a BigInt, which is what ethers uses for numbers from the contract
  return { ...ctx, animalId: 1n, birth };
}

// Makes everything available to the test files
module.exports = { ROLES, Sex, Status, RecordType, DAY, deployFixture, withAnimalFixture };