
// Hardhat test suite for CattleRegistry smart contract

// In the testing, it is more important to check the rejecting unauthorised or invalid actions

///////////////////////////////////////////////
// Starting with 4 requirement statements
///////////////////////////////////////////////

// chai the assertion library 
const { expect } = require("chai");
// Ethers.js integration from Hardhat
const { ethers } = require("hardhat");
// Testing helpers from Hardhat
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
// Importing shared test data and setup functions
const { ROLES, Sex, Status, DAY, deployFixture, withAnimalFixture } = require("./fixtures");

///////////////////////////////////////////////
// Using the Mocha testing framework
///////////////////////////////////////////////

// The CattleRegistry group of tests, all concerning animal registration
describe("CattleRegistry", () => {

  ///////////////////////////////////////////////
  // Deployment and admin access
  ///////////////////////////////////////////////

  // Checking the contract deploys properly and only the right people can use the admin functions
  describe("deployment & access control", () => {
    // Constructor sets the admin, and deploying with the zero address (nobody) should fail
    it("makes the constructor argument the admin and rejects the zero address", async () => {
      // loadFixture runs the deploy once then resets the chain back to that snapshot for each test, so it is fast
      const { registry, admin } = await loadFixture(deployFixture);
      // Checking the address passed in really got the admin role
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      const F = await ethers.getContractFactory("CattleRegistry");
      // Trying to deploy with the zero address as admin, should be rejected
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "InvalidInput");
    });

    // A stranger with no roles tries all three admin functions, each one should be rejected
    it("only the admin can grant roles, set the guard and pause", async () => {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).grantRole(ROLES.FARMER, stranger.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.connect(stranger).setGuard(stranger.address))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.connect(stranger).pause())
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    // Admin sets the guard and the event shows the new address (stranger's address is just used as any address here)
    it("emits GuardUpdated", async () => {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(registry.setGuard(stranger.address)).to.emit(registry, "GuardUpdated").withArgs(stranger.address);
    });
  });

  ///////////////////////////////////////////////
  // Registering animals
  ///////////////////////////////////////////////

  // Registering a new animal, what gets stored and what should be refused
  describe("registerAnimal", () => {
    // Happy path, withAnimalFixture already registers animal 1 for farmerA so we just read it back and check it
    it("registers an animal, stores its data and opens the movement history", async () => {
      const { registry, farmerA, animalId, birth } = await loadFixture(withAnimalFixture);
      const a = await registry.getAnimal(animalId);
      expect(a.owner).to.equal(farmerA.address);
      // The tag is stored as a hash, not the full string
      expect(a.tagHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes("IE123456780001")));
      expect(a.breed).to.equal("Hereford");
      expect(a.sex).to.equal(Sex.Female);
      expect(a.status).to.equal(Status.Alive);
      expect(a.birthDate).to.equal(birth);
      expect(a.location).to.equal("Herd IE1234567, Louth");
      // The n on the end makes it a BigInt, which is what ethers returns for numbers from the contract
      expect(await registry.totalAnimals()).to.equal(1n);
      expect(await registry.idByTag("IE123456780001")).to.equal(1n);
      // Registering counts as the first movement
      expect(await registry.movementCount(animalId)).to.equal(1n);
    });

    // The event has the full tag even though only the hash is stored, and 1n is the first animal id
    it("emits AnimalRegistered with the full tag", async () => {
      const { registry, farmerA } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(registry.connect(farmerA).registerAnimal("IE000000000002", "Angus", Sex.Male, now - DAY, "Barn 2"))
        .to.emit(registry, "AnimalRegistered")
        .withArgs(1n, ethers.keccak256(ethers.toUtf8Bytes("IE000000000002")), "IE000000000002", farmerA.address, "Angus", Sex.Male, now - DAY, "Barn 2");
    });

    // Ids go up by one each time, no matter which farmer registers
    it("assigns sequential ids", async () => {
      const { registry, farmerA, farmerB, birth } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerB).registerAnimal("IE123456780002", "Charolais", Sex.Male, birth, "Yard");
      await registry.connect(farmerA).registerAnimal("IE123456780003", "Limousin", Sex.Female, birth, "Yard");
      expect(await registry.totalAnimals()).to.equal(3n);
      expect(await registry.ownerOf(2)).to.equal(farmerB.address);
    });

    // Same tag from a different farmer should still fail, tags are unique across the whole registry
    it("rejects duplicate tags, even from a different farmer", async () => {
      const { registry, farmerB, birth } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(farmerB).registerAnimal("IE123456780001", "Angus", Sex.Male, birth, "Yard"))
        .to.be.revertedWithCustomError(registry, "TagAlreadyRegistered");
    });

    // Vet and stranger don't have the farmer role so both are rejected, the loop just runs the same check for each
    it("rejects callers without FARMER_ROLE", async () => {
      const { registry, vet, stranger, birth } = await loadFixture(withAnimalFixture);
      for (const s of [vet, stranger]) {
        await expect(registry.connect(s).registerAnimal("IE999", "Angus", Sex.Male, birth, "Yard"))
          .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      }
    });

    // Each bad input in turn, all should fail with InvalidInput
    // Empty tag, tag too long (33 characters, limit is 32), empty breed, empty location, location too long (65, limit is 64), birth date in the future
    // r is just farmerA connected to the registry so the repeated calls are shorter, and now - 1 is a second ago which is a valid birth date
    it("validates inputs", async () => {
      const { registry, farmerA } = await loadFixture(deployFixture);
      const now = await time.latest();
      const r = registry.connect(farmerA);
      await expect(r.registerAnimal("", "Angus", Sex.Male, now - 1, "Yard")).to.be.revertedWithCustomError(registry, "InvalidInput");
      await expect(r.registerAnimal("X".repeat(33), "Angus", Sex.Male, now - 1, "Yard")).to.be.revertedWithCustomError(registry, "InvalidInput");
      await expect(r.registerAnimal("T1", "", Sex.Male, now - 1, "Yard")).to.be.revertedWithCustomError(registry, "InvalidInput");
      await expect(r.registerAnimal("T1", "Angus", Sex.Male, now - 1, "")).to.be.revertedWithCustomError(registry, "InvalidInput");
      await expect(r.registerAnimal("T1", "Angus", Sex.Male, now - 1, "L".repeat(65))).to.be.revertedWithCustomError(registry, "InvalidInput");
      await expect(r.registerAnimal("T1", "Angus", Sex.Male, now + 10 * DAY, "Yard")).to.be.revertedWithCustomError(registry, "InvalidInput");
    });
  });

  ///////////////////////////////////////////////
  // Read only functions
  ///////////////////////////////////////////////

  // The view functions, which only read and don't change anything
  describe("views", () => {
    // Id 0 is never valid (ids start at 1), and 2 and 99 don't exist yet, so those revert
    // An unknown tag returns 0 instead of reverting
    it("reverts on unknown ids and returns 0 for unknown tags", async () => {
      const { registry } = await loadFixture(withAnimalFixture);
      await expect(registry.getAnimal(0)).to.be.revertedWithCustomError(registry, "UnknownAnimal");
      await expect(registry.getAnimal(2)).to.be.revertedWithCustomError(registry, "UnknownAnimal");
      await expect(registry.ownerOf(99)).to.be.revertedWithCustomError(registry, "UnknownAnimal");
      expect(await registry.idByTag("NOPE")).to.equal(0n);
      expect(await registry.animalExists(1)).to.equal(true);
      expect(await registry.animalExists(0)).to.equal(false);
    });
  });

  ///////////////////////////////////////////////
  // Movements
  ///////////////////////////////////////////////

  // Moving an animal between locations and reading the history back
  describe("movements", () => {
    // Three movements on top of the one from registering makes 4 in total, and the history comes back oldest first
    // The arguments to getMovements are (animalId, offset, limit)
    it("lets the owner record movements, oldest first, with pagination", async () => {
      const { registry, farmerA, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).recordMovement(animalId, "Summer pasture");
      await registry.connect(farmerA).recordMovement(animalId, "Winter shed");
      await registry.connect(farmerA).recordMovement(animalId, "Handling pen");

      expect(await registry.movementCount(animalId)).to.equal(4n);
      const all = await registry.getMovements(animalId, 0, 10);
      expect(all.map((m) => m.location)).to.deep.equal(["Herd IE1234567, Louth", "Summer pasture", "Winter shed", "Handling pen"]);

      // Offset 1 and limit 2 gives the second and third movements
      const page = await registry.getMovements(animalId, 1, 2);
      expect(page.map((m) => m.location)).to.deep.equal(["Summer pasture", "Winter shed"]);
      // Offset 3 only has one item left even though the limit is 10
      expect((await registry.getMovements(animalId, 3, 10)).length).to.equal(1);
      // An offset at or past the end gives an empty list, not an error
      expect((await registry.getMovements(animalId, 4, 10)).length).to.equal(0);
      expect((await registry.getMovements(animalId, 100, 10)).length).to.equal(0);
      // The animal's current location is the latest movement
      expect((await registry.getAnimal(animalId)).location).to.equal("Handling pen");
    });

    // The event is emitted for a good move, then the bad cases: someone else's animal, an empty location, an animal that doesn't exist
    it("emits MovementRecorded and rejects non-owners and bad locations", async () => {
      const { registry, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(farmerA).recordMovement(animalId, "Pasture"))
        .to.emit(registry, "MovementRecorded").withArgs(animalId, farmerA.address, "Pasture");
      await expect(registry.connect(farmerB).recordMovement(animalId, "Pasture"))
        .to.be.revertedWithCustomError(registry, "NotAnimalOwner");
      await expect(registry.connect(farmerA).recordMovement(animalId, ""))
        .to.be.revertedWithCustomError(registry, "InvalidInput");
      await expect(registry.connect(farmerA).recordMovement(99, "Pasture"))
        .to.be.revertedWithCustomError(registry, "UnknownAnimal");
    });
  });

  ///////////////////////////////////////////////
  // Transferring ownership
  ///////////////////////////////////////////////

  // The owner offers the animal and the other person has to accept, nothing changes hands until they do
  describe("two-step transfer", () => {
    // Full happy path, A offers and B accepts, and ownership only changes on the accept
    it("completes propose → accept, moves ownership and logs the new location", async () => {
      const { registry, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(farmerA).proposeTransfer(animalId, farmerB.address))
        .to.emit(registry, "TransferProposed").withArgs(animalId, farmerA.address, farmerB.address);
      expect(await registry.pendingOwner(animalId)).to.equal(farmerB.address);
      // ownership has not changed yet
      expect(await registry.ownerOf(animalId)).to.equal(farmerA.address);

      await expect(registry.connect(farmerB).acceptTransfer(animalId, "B's farm"))
        .to.emit(registry, "TransferAccepted").withArgs(animalId, farmerA.address, farmerB.address);
      expect(await registry.ownerOf(animalId)).to.equal(farmerB.address);
      expect(await registry.pendingOwner(animalId)).to.equal(ethers.ZeroAddress);

      // Accepting adds a second movement showing where the animal went and who recorded it
      const moves = await registry.getMovements(animalId, 0, 10);
      expect(moves.length).to.equal(2);
      expect(moves[1].location).to.equal("B's farm");
      expect(moves[1].by).to.equal(farmerB.address);
    });

    // Once B has accepted, A can no longer move the animal or offer it again
    it("previous owner loses control after transfer", async () => {
      const { registry, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await registry.connect(farmerB).acceptTransfer(animalId, "B's farm");
      await expect(registry.connect(farmerA).recordMovement(animalId, "Back home"))
        .to.be.revertedWithCustomError(registry, "NotAnimalOwner");
      await expect(registry.connect(farmerA).proposeTransfer(animalId, farmerB.address))
        .to.be.revertedWithCustomError(registry, "NotAnimalOwner");
    });

    // Only the address the animal was offered to can accept, not the processor and not the owner
    it("only the proposed recipient can accept", async () => {
      const { registry, farmerA, farmerB, processor, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await expect(registry.connect(processor).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "NotPendingOwner");
      await expect(registry.connect(farmerA).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "NotPendingOwner");
    });

    // Trying to accept when nothing was ever offered
    it("rejects accept without a proposal", async () => {
      const { registry, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(farmerB).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "NoPendingTransfer");
    });

    // Offering to the zero address, to yourself, to an address with no role and to a vet should all fail
    // A vet is not a farmer or a processor so it can't receive an animal
    it("rejects invalid recipients (zero, self, no role)", async () => {
      const { registry, farmerA, vet, stranger, animalId } = await loadFixture(withAnimalFixture);
      const r = registry.connect(farmerA);
      await expect(r.proposeTransfer(animalId, ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "InvalidRecipient");
      await expect(r.proposeTransfer(animalId, farmerA.address)).to.be.revertedWithCustomError(registry, "InvalidRecipient");
      await expect(r.proposeTransfer(animalId, stranger.address)).to.be.revertedWithCustomError(registry, "InvalidRecipient");
      await expect(r.proposeTransfer(animalId, vet.address)).to.be.revertedWithCustomError(registry, "InvalidRecipient");
    });

    // The role is checked again at accept time, so removing B's farmer role after the offer blocks the accept
    it("re-checks the recipient's role at accept time", async () => {
      const { registry, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await registry.revokeRole(ROLES.FARMER, farmerB.address);
      await expect(registry.connect(farmerB).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "InvalidRecipient");
    });

    // Cancelling works and clears the offer, and a new offer replaces the old one
    // So after offering to the processor, B can no longer accept but the processor can
    it("owner can cancel; a new proposal overwrites the old one", async () => {
      const { registry, farmerA, farmerB, processor, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await expect(registry.connect(farmerA).cancelTransfer(animalId))
        .to.emit(registry, "TransferCancelled").withArgs(animalId, farmerA.address, farmerB.address);
      await expect(registry.connect(farmerB).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "NoPendingTransfer");
      await expect(registry.connect(farmerA).cancelTransfer(animalId)).to.be.revertedWithCustomError(registry, "NoPendingTransfer");

      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await registry.connect(farmerA).proposeTransfer(animalId, processor.address);
      await expect(registry.connect(farmerB).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "NotPendingOwner");
      await registry.connect(processor).acceptTransfer(animalId, "Plant");
      expect(await registry.ownerOf(animalId)).to.equal(processor.address);
    });

    // Only the owner can cancel, not the person the animal was offered to
    it("non-owners cannot cancel", async () => {
      const { registry, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await expect(registry.connect(farmerB).cancelTransfer(animalId)).to.be.revertedWithCustomError(registry, "NotAnimalOwner");
    });
  });

  ///////////////////////////////////////////////
  // End of life
  ///////////////////////////////////////////////

  // An animal ends as deceased or slaughtered, after that its record is closed
  describe("life-cycle", () => {
    // Owner marks it deceased, the pending offer gets cleared and every action after that is rejected
    it("owner can mark an animal deceased and it becomes inert", async () => {
      const { registry, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await expect(registry.connect(farmerA).markDeceased(animalId, "Calving complications"))
        .to.emit(registry, "AnimalDeceased").withArgs(animalId, farmerA.address, "Calving complications");

      expect((await registry.getAnimal(animalId)).status).to.equal(Status.Deceased);
      expect(await registry.pendingOwner(animalId)).to.equal(ethers.ZeroAddress);
      await expect(registry.connect(farmerA).recordMovement(animalId, "x")).to.be.revertedWithCustomError(registry, "AnimalNotAlive");
      await expect(registry.connect(farmerA).proposeTransfer(animalId, farmerB.address)).to.be.revertedWithCustomError(registry, "AnimalNotAlive");
      await expect(registry.connect(farmerA).markDeceased(animalId, "again")).to.be.revertedWithCustomError(registry, "AnimalNotAlive");
    });

    // The owner or a vet can record a death, nobody else can
    it("a vet can also record death; strangers and other farmers cannot", async () => {
      const { registry, farmerB, vet, stranger, animalId } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(stranger).markDeceased(animalId, "x")).to.be.revertedWithCustomError(registry, "NotAuthorised");
      await expect(registry.connect(farmerB).markDeceased(animalId, "x")).to.be.revertedWithCustomError(registry, "NotAuthorised");
      await registry.connect(vet).markDeceased(animalId, "Euthanised");
      expect((await registry.getAnimal(animalId)).status).to.equal(Status.Deceased);
    });

    // The reason limit is 280 characters, so 281 should fail
    it("rejects an over-long reason", async () => {
      const { registry, farmerA, animalId } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(farmerA).markDeceased(animalId, "r".repeat(281))).to.be.revertedWithCustomError(registry, "InvalidInput");
    });

    // Transfer to the processor first, then the processor marks it slaughtered
    // Doing it a second time fails because the animal is no longer alive
    it("a processor that owns the animal can mark it slaughtered", async () => {
      const { registry, farmerA, processor, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, processor.address);
      await registry.connect(processor).acceptTransfer(animalId, "Meat plant, Dundalk");
      await expect(registry.connect(processor).markSlaughtered(animalId))
        .to.emit(registry, "AnimalSlaughtered").withArgs(animalId, processor.address);
      expect((await registry.getAnimal(animalId)).status).to.equal(Status.Slaughtered);
      await expect(registry.connect(processor).markSlaughtered(animalId)).to.be.revertedWithCustomError(registry, "AnimalNotAlive");
    });

    // A farmer has no processor role so is rejected on the role first
    // A processor that doesn't own the animal is rejected on ownership, so the order of the checks matters here
    it("slaughter requires PROCESSOR_ROLE and ownership", async () => {
      const { registry, farmerA, processor, animalId } = await loadFixture(withAnimalFixture);
      await expect(registry.connect(farmerA).markSlaughtered(animalId)).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.connect(processor).markSlaughtered(animalId)).to.be.revertedWithCustomError(registry, "NotAnimalOwner");
    });
  });

  ///////////////////////////////////////////////
  // Emergency stop
  ///////////////////////////////////////////////

  // The admin can pause the registry and every function that changes something stops working
  describe("pause", () => {
    // The offer is made before the pause so there is something to accept and cancel
    // While paused every change is rejected, reading still works, and after unpause things carry on as normal
    it("blocks every state-changing call while paused and resumes after unpause", async () => {
      const { registry, farmerA, farmerB, animalId, birth } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await registry.pause();

      await expect(registry.connect(farmerA).registerAnimal("IE5", "Angus", Sex.Male, birth, "Y")).to.be.revertedWithCustomError(registry, "EnforcedPause");
      await expect(registry.connect(farmerA).recordMovement(animalId, "Y")).to.be.revertedWithCustomError(registry, "EnforcedPause");
      await expect(registry.connect(farmerA).cancelTransfer(animalId)).to.be.revertedWithCustomError(registry, "EnforcedPause");
      await expect(registry.connect(farmerB).acceptTransfer(animalId, "Y")).to.be.revertedWithCustomError(registry, "EnforcedPause");
      await expect(registry.connect(farmerA).markDeceased(animalId, "x")).to.be.revertedWithCustomError(registry, "EnforcedPause");
      // views still work
      expect((await registry.getAnimal(animalId)).breed).to.equal("Hereford");

      await registry.unpause();
      await registry.connect(farmerB).acceptTransfer(animalId, "Y");
      expect(await registry.ownerOf(animalId)).to.equal(farmerB.address);
    });
  });
});
 