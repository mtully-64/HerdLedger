// Hardhat test suite for HealthRecords smart contract

// Same approach as the registry tests, the focus is on rejecting the wrong people and the wrong actions
// This contract also talks to the registry, so some tests call both contracts together

// chai the assertion library
const { expect } = require("chai");
// Ethers.js integration from Hardhat
const { ethers } = require("hardhat");
// Testing helpers from Hardhat, time lets us jump the blockchain clock forward
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
// Importing shared test data and setup functions
const { RecordType, Status, DAY, deployFixture, withAnimalFixture } = require("./fixtures");

// A made up document hash used in the records, ethers.id hashes the string into the same 32 byte format a real one would be
// Real documents stay off the blockchain, only the hash is stored
const DOC = ethers.id("lab-report.pdf");

// The HealthRecords group of tests, all concerning vet records, withdrawal periods and restrictions
describe("HealthRecords", () => {

  ///////////////////////////////////////////////
  // Deployment
  ///////////////////////////////////////////////

  describe("deployment", () => {
    // Checks the contract remembers which registry it is connected to, and that deploying with the zero address fails
    it("points at the registry and rejects the zero address", async () => {
      const { registry, health } = await loadFixture(deployFixture);
      expect(await health.registry()).to.equal(await registry.getAddress());
      const F = await ethers.getContractFactory("HealthRecords");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(health, "InvalidInput");
    });
  });

  ///////////////////////////////////////////////
  // Adding records
  ///////////////////////////////////////////////

  // Vets adding health records to an animal, and who is not allowed to
  describe("addRecord", () => {
    // The arguments to addRecord are (animalId, type, withdrawalDays, adverse, documentHash, note)
    // Vet adds two records then reads them back, the order they were added is the order they come back
    it("lets a vet add records and reads them back in order", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Vaccination, 0, false, DOC, "Clostridial 7-in-1");
      // ZeroHash means no document was attached
      await health.connect(vet).addRecord(animalId, RecordType.Inspection, 0, false, ethers.ZeroHash, "Routine herd check");

      expect(await health.recordCount(animalId)).to.equal(2n);
      // The arguments to getRecords are (animalId, offset, limit)
      const recs = await health.getRecords(animalId, 0, 10);
      expect(recs.map((r) => r.note)).to.deep.equal(["Clostridial 7-in-1", "Routine herd check"]);
      expect(recs[0].vet).to.equal(vet.address);
      expect(recs[0].recordType).to.equal(RecordType.Vaccination);
      expect(recs[0].documentHash).to.equal(DOC);
      // A vaccination with 0 withdrawal days has no end date
      expect(recs[0].withdrawalEnd).to.equal(0n);
      // Offset 1 has one record left, offset 2 is past the end so it gives an empty list
      expect((await health.getRecords(animalId, 1, 5)).length).to.equal(1);
      expect((await health.getRecords(animalId, 2, 5)).length).to.equal(0);
    });

    // The event has the index of the record, 0n is the first one, and 0n for the withdrawal end because there isn't one
    it("emits HealthRecordAdded with the record index", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      await expect(health.connect(vet).addRecord(animalId, RecordType.Inspection, 0, false, DOC, "ok"))
        .to.emit(health, "HealthRecordAdded").withArgs(animalId, 0n, RecordType.Inspection, vet.address, false, 0n, DOC, "ok");
    });

    // Farmer, processor and stranger all try to add a record and none of them are vets, the loop just repeats the check
    // The vet role is checked on the registry, HealthRecords has no roles of its own
    it("is restricted to vets (role read from the registry)", async () => {
      const { health, farmerA, processor, stranger, animalId } = await loadFixture(withAnimalFixture);
      for (const s of [farmerA, processor, stranger]) {
        await expect(health.connect(s).addRecord(animalId, RecordType.Inspection, 0, false, DOC, "x"))
          .to.be.revertedWithCustomError(health, "NotVet");
      }
    });

    // Because the roles live in the registry, changing them there takes effect here straight away
    // The stranger is made a vet and can add a record, then the original vet loses the role and can't
    it("follows role changes in the registry", async () => {
      const { registry, health, vet, stranger, animalId } = await loadFixture(withAnimalFixture);
      await registry.grantRole(await registry.VET_ROLE(), stranger.address);
      await health.connect(stranger).addRecord(animalId, RecordType.Inspection, 0, false, DOC, "x");
      await registry.revokeRole(await registry.VET_ROLE(), vet.address);
      await expect(health.connect(vet).addRecord(animalId, RecordType.Inspection, 0, false, DOC, "x"))
        .to.be.revertedWithCustomError(health, "NotVet");
    });

    // Each bad input in turn
    // Animal 99 and animal 0 don't exist, a note of 281 characters is over the limit of 280
    // A withdrawal over 365 days is too long, and only vaccinations and treatments can have a withdrawal at all so a Test or Inspection with 7 days fails
    it("rejects unknown animals, long notes and bad withdrawal values", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      const h = health.connect(vet);
      await expect(h.addRecord(99, RecordType.Inspection, 0, false, DOC, "x")).to.be.revertedWithCustomError(health, "UnknownAnimal");
      await expect(h.addRecord(0, RecordType.Inspection, 0, false, DOC, "x")).to.be.revertedWithCustomError(health, "UnknownAnimal");
      await expect(h.addRecord(animalId, RecordType.Inspection, 0, false, DOC, "n".repeat(281))).to.be.revertedWithCustomError(health, "InvalidInput");
      await expect(h.addRecord(animalId, RecordType.Treatment, 366, false, DOC, "x")).to.be.revertedWithCustomError(health, "InvalidWithdrawal");
      await expect(h.addRecord(animalId, RecordType.Test, 7, false, DOC, "x")).to.be.revertedWithCustomError(health, "InvalidWithdrawal");
      await expect(h.addRecord(animalId, RecordType.Inspection, 7, false, DOC, "x")).to.be.revertedWithCustomError(health, "InvalidWithdrawal");
    });
  });

  ///////////////////////////////////////////////
  // Withdrawal periods
  ///////////////////////////////////////////////

  // After some medicines the animal can't be slaughtered for a set number of days, this is the withdrawal period
  describe("withdrawal periods", () => {
    // Starts with no withdrawal, a 28 day treatment starts one, and the end date only ever moves later
    it("tracks the latest withdrawal end across several treatments", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      expect(await health.isInWithdrawal(animalId)).to.equal(false);

      await health.connect(vet).addRecord(animalId, RecordType.Treatment, 28, false, DOC, "Antibiotic");
      // first holds the end date from the 28 day treatment, to compare against after the next records
      const first = await health.withdrawalEndOf(animalId);
      expect(await health.isInWithdrawal(animalId)).to.equal(true);

      // a shorter later treatment must not shorten the window
      await health.connect(vet).addRecord(animalId, RecordType.Vaccination, 1, false, DOC, "Booster");
      expect(await health.withdrawalEndOf(animalId)).to.equal(first);

      // a longer one extends it
      // gt means greater than
      await health.connect(vet).addRecord(animalId, RecordType.Treatment, 60, false, DOC, "Longer course");
      expect(await health.withdrawalEndOf(animalId)).to.be.gt(first);
    });

    // A 10 day treatment, after 9 days it is still running and after 2 more days it has ended
    // time.increase jumps the blockchain clock forward so we don't have to wait
    it("expires once the period has passed", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Treatment, 10, false, DOC, "Antibiotic");
      await time.increase(9 * DAY);
      expect(await health.isInWithdrawal(animalId)).to.equal(true);
      await time.increase(2 * DAY);
      expect(await health.isInWithdrawal(animalId)).to.equal(false);
    });

    // The animal goes to the processor first because only a processor that owns it can record slaughter
    // Slaughter is rejected during the 14 day withdrawal, then 15 days later it goes through
    it("blocks slaughter during withdrawal and allows it afterwards", async () => {
      const { registry, health, vet, farmerA, processor, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Treatment, 14, false, DOC, "Antibiotic");
      await registry.connect(farmerA).proposeTransfer(animalId, processor.address);
      await registry.connect(processor).acceptTransfer(animalId, "Plant");

      await expect(registry.connect(processor).markSlaughtered(animalId)).to.be.revertedWithCustomError(registry, "InWithdrawalPeriod");
      await time.increase(15 * DAY);
      await registry.connect(processor).markSlaughtered(animalId);
      expect((await registry.getAnimal(animalId)).status).to.equal(Status.Slaughtered);
    });

    // Setting the guard to the zero address turns the check off, so slaughter goes through even during a withdrawal
    // This shows the guard is optional and the registry works without it
    it("does not block anything when no guard is configured", async () => {
      const { registry, health, vet, farmerA, processor, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Treatment, 14, false, DOC, "Antibiotic");
      await registry.setGuard(ethers.ZeroAddress);
      await registry.connect(farmerA).proposeTransfer(animalId, processor.address);
      await registry.connect(processor).acceptTransfer(animalId, "Plant");
      await registry.connect(processor).markSlaughtered(animalId);
    });
  });

  ///////////////////////////////////////////////
  // Restrictions
  ///////////////////////////////////////////////

  // A restricted animal can't move or go to a farmer, it can only be sent to a processor
  describe("restrictions", () => {
    // The true in the addRecord call marks it as an adverse result, on a Test that restricts the animal automatically
    // The event has that exact reason string
    it("an adverse test result restricts the animal automatically", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      await expect(health.connect(vet).addRecord(animalId, RecordType.Test, 0, true, DOC, "TB reactor"))
        .to.emit(health, "RestrictionSet").withArgs(animalId, true, vet.address, "Adverse test result");
      expect(await health.isRestricted(animalId)).to.equal(true);
    });

    // Only an adverse Test restricts, a clear test doesn't and neither does an adverse result on an Inspection
    it("a clear test result or adverse non-test record does not restrict", async () => {
      const { health, vet, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Test, 0, false, DOC, "Clear");
      await health.connect(vet).addRecord(animalId, RecordType.Inspection, 0, true, DOC, "Noted limp");
      expect(await health.isRestricted(animalId)).to.equal(false);
    });

    // Restricted so it can't move and can't be offered to another farmer
    // It can still go to the processor and be slaughtered
    it("restricted animals cannot move or go to farmers, but can go to a processor", async () => {
      const { registry, health, vet, farmerA, farmerB, processor, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Test, 0, true, DOC, "TB reactor");

      await expect(registry.connect(farmerA).recordMovement(animalId, "Neighbour's field")).to.be.revertedWithCustomError(registry, "AnimalRestricted");
      await expect(registry.connect(farmerA).proposeTransfer(animalId, farmerB.address)).to.be.revertedWithCustomError(registry, "AnimalRestricted");

      await registry.connect(farmerA).proposeTransfer(animalId, processor.address);
      await registry.connect(processor).acceptTransfer(animalId, "Plant");
      await registry.connect(processor).markSlaughtered(animalId);
      expect((await registry.getAnimal(animalId)).status).to.equal(Status.Slaughtered);
    });

    // The offer to farmer B is made first, then the animal gets restricted, then B tries to accept
    // It fails because the restriction is checked again at accept time, not just when it was offered
    it("a restriction placed after proposal blocks acceptance by a farmer", async () => {
      const { registry, health, vet, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await health.connect(vet).addRecord(animalId, RecordType.Test, 0, true, DOC, "TB reactor");
      await expect(registry.connect(farmerB).acceptTransfer(animalId, "x")).to.be.revertedWithCustomError(registry, "AnimalRestricted");
    });

    // The vet lifts the restriction by calling setRestriction with false, after that moving and offering work again
    it("a vet can lift a restriction, which restores normal movement", async () => {
      const { registry, health, vet, farmerA, farmerB, animalId } = await loadFixture(withAnimalFixture);
      await health.connect(vet).addRecord(animalId, RecordType.Test, 0, true, DOC, "TB reactor");
      await expect(health.connect(vet).setRestriction(animalId, false, "Re-test clear"))
        .to.emit(health, "RestrictionSet").withArgs(animalId, false, vet.address, "Re-test clear");
      await registry.connect(farmerA).recordMovement(animalId, "Pasture");
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
    });

    // A farmer can't set a restriction, animal 99 doesn't exist, and a reason of 281 characters is over the limit of 280
    it("only vets can set restrictions, only on real animals, with bounded reasons", async () => {
      const { health, vet, farmerA, animalId } = await loadFixture(withAnimalFixture);
      await expect(health.connect(farmerA).setRestriction(animalId, true, "x")).to.be.revertedWithCustomError(health, "NotVet");
      await expect(health.connect(vet).setRestriction(99, true, "x")).to.be.revertedWithCustomError(health, "UnknownAnimal");
      await expect(health.connect(vet).setRestriction(animalId, true, "r".repeat(281))).to.be.revertedWithCustomError(health, "InvalidInput");
    });
  });

  ///////////////////////////////////////////////
  // Full run through
  ///////////////////////////////////////////////

  // One test that puts both contracts together and follows an animal from start to finish
  describe("end-to-end", () => {
    // Vaccination, a move, farm A offers to farm B, a 7 day treatment, wait 8 days so the withdrawal is over
    // Then B offers to the processor and the processor slaughters it
    // 4 movements are registering, summer pasture, B's farm and the plant, and 2 health records
    it("farm → farm → processor with records along the way", async () => {
      const { registry, health, vet, farmerA, farmerB, processor, animalId } = await loadFixture(withAnimalFixture);

      await health.connect(vet).addRecord(animalId, RecordType.Vaccination, 0, false, DOC, "Annual vaccines");
      await registry.connect(farmerA).recordMovement(animalId, "Summer pasture");
      await registry.connect(farmerA).proposeTransfer(animalId, farmerB.address);
      await registry.connect(farmerB).acceptTransfer(animalId, "Finishing unit");
      await health.connect(vet).addRecord(animalId, RecordType.Treatment, 7, false, DOC, "Fluke dose");
      await time.increase(8 * DAY);
      await registry.connect(farmerB).proposeTransfer(animalId, processor.address);
      await registry.connect(processor).acceptTransfer(animalId, "Plant");
      await registry.connect(processor).markSlaughtered(animalId);

      expect(await registry.movementCount(animalId)).to.equal(4n);
      expect(await health.recordCount(animalId)).to.equal(2n);
      expect((await registry.getAnimal(animalId)).status).to.equal(Status.Slaughtered);
    });
  });
});