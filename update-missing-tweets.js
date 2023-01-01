// external
const { createAlchemyWeb3 } = require("@alch/alchemy-web3");
const { ethers } = require("ethers");
const retry = require("async-retry");
const _ = require("lodash");
// local
const { markets } = require("./markets.js");
const { getTokenData, getSeaportSalePrice } = require("./utils.js");
const { currencies } = require("./currencies.js");
const { transferEventTypes, saleEventTypes } = require("./log_event_types.js");
const { tweet } = require("./tweet");
const abi = require("./abi.json");

// connect to Alchemy websocket
const web3 = createAlchemyWeb3(
  `wss://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`
);

const fromBlock = 16307145;
async function main() {
  const contract = new web3.eth.Contract(abi, process.env.CONTRACT_ADDRESS);

  //   // get the transactions from the past 24 hours
  const transactions = await contract.getPastEvents("Transfer", {
    // calculate block from 1 day ago
    fromBlock,
    toBlock: "latest",
  });

  console.log("Found", transactions.length, "transactions");

  //   // for each transaction, get the transaction receipt
  const transactionReceipts = await Promise.all(
    transactions.map(async (transaction) => {
      const transactionHash = transaction.transactionHash.toLowerCase();
      const receipt = await retry(
        async (bail) => {
          const rec = await web3.eth.getTransactionReceipt(transactionHash);

          if (rec == null) {
            throw new Error("receipt not found, try again");
          }

          return rec;
        },
        {
          retries: 5,
        }
      );

      return receipt;
    })
  );

  console.log("Found", transactionReceipts.length, "transaction receipts");

  // iterate each receipt in the markets
  for (const receipt of transactionReceipts) {
    const recipient = receipt.to.toLowerCase();

    // not a marketplace transaction transfer, skip
    if (!(recipient in markets)) {
      continue;
    }

    const market = markets[recipient];

    let currency = {
      name: "ETH",
      decimals: 18,
      threshold: 1,
    };
    let tokens = [];
    let totalPrice = 0;

    for (let log of receipt.logs) {
      const logAddress = log.address.toLowerCase();

      // if non-ETH transaction
      if (logAddress in currencies) {
        currency = currencies[logAddress];
      }

      // token(s) part of the transaction
      if (log.data == "0x" && transferEventTypes.includes(log.topics[0])) {
        const tokenId = web3.utils.hexToNumberString(log.topics[3]);

        tokens.push(tokenId);
      }

      // transaction log - decode log in correct format depending on market & retrieve price
      if (logAddress == recipient && saleEventTypes.includes(log.topics[0])) {
        const decodedLogData = web3.eth.abi.decodeLog(
          market.logDecoder,
          log.data,
          []
        );

        if (market.name == "Opensea ⚓️") {
          totalPrice += getSeaportSalePrice(decodedLogData);
        } else if (market.name == "X2Y2 ⭕️") {
          totalPrice += ethers.utils.formatUnits(
            decodedLogData.amount,
            currency.decimals
          );
        } else {
          totalPrice += ethers.utils.formatUnits(
            decodedLogData.price,
            currency.decimals
          );
        }
      }
    }

    // remove any dupes
    tokens = _.uniq(tokens);

    console.log(
      `Transaction Hash: ${receipt.transactionHash.toLowerCase()}`,
      `Token ID: ${tokens[0]}, Price: ${totalPrice}, Currency: ${currency.name}, Market: ${market.name}`
    );

    const tokenData = await getTokenData(tokens[0]);

    if (tokens.length > 1) {
      tweet(
        `${_.get(
          tokenData,
          "assetName",
          `#` + tokens[0]
        )} & other assets bought for ${totalPrice} ${currency.name} on ${
          market.name
        }`
      );
    } else {
      tweet(
        `${_.get(
          tokenData,
          "assetName",
          `#` + tokens[0]
        )} bought for ${totalPrice} ${currency.name} on ${market.name} ${
          market.site
        }${process.env.CONTRACT_ADDRESS}/${tokens[0]}`
      );
    }
  }
}

main();
