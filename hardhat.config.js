// Loading in the package so my Hardhat can:
// Register ethers - deploy/interact with smart contracts from JS or TS
// The Chai matches - give specialised assertions for testing my smart contracts
// The gas reporter - measure my gas consumption by contract operations
require("@nomicfoundation/hardhat-toolbox")

module.exports = {
  // My solidity compiler to translate my .sol files into the bytecode for the Ethereum Virtual Machine
  solidity: {
    version: "0.8.24",
    settings: {
      // Make the contract's bytecode more efficient and assume number of executions of the contract's code to 200
      optimizer: { 
        enabled: true, 
        runs: 200 
      },
      evmVersion: "cancun",
    },
  },
};