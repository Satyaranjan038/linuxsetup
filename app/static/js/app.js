const helloButton = document.getElementById("helloButton");
const result = document.getElementById("result");

helloButton.addEventListener("click", async () => {

    result.innerText = "Calling FastAPI...";

    try {

        const response = await fetch("/api/hello");

        if (!response.ok) {
            throw new Error("API request failed");
        }

        const data = await response.json();

        result.innerText =
            data.message + " | " + data.server;

    } catch (error) {

        result.innerText =
            "Error connecting to FastAPI.";

        console.error(error);
    }
});